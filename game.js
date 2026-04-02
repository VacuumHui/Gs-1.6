/**
 * @file game.js
 * @description Основной движок игры: Phaser сцены, физика, рендер, интерполяция.
 */

import InputManager from './input.js';
import NetworkManager from './network.js';
import WeaponState from './weapons.js';
import { NET_CONFIG, GAME_CONFIG } from './config.js';

// --- SCENE 1: UI (Джойстики) ---
class UIScene extends Phaser.Scene {
    constructor() {
        super({ key: 'UIScene' });
    }

    preload() {
        // Загружаем плагин напрямую из официального репозитория. 
        // Это гарантирует, что он будет доступен на 100%!
        this.load.plugin('rexvirtualjoystickplugin', 'https://cdn.jsdelivr.net/npm/phaser3-rex-plugins/dist/rexvirtualjoystickplugin.min.js', true);
    }

    create() {
        // Джойстики не привязаны к камере, поэтому они в отдельной сцене поверх основной
        this.inputManager = new InputManager(this);
    }
}

// --- SCENE 2: MAIN GAME (Логика и Мир) ---
class GameScene extends Phaser.Scene {
    constructor() {
        super({ key: 'GameScene' });
    }

    init(data) {
        this.network = data.network; // Проброшенный NetworkManager
        this.isHost = this.network.isHost;
        this.myId = this.network.peer.id;
        
        // Игровое состояние
        this.players = new Map(); // id -> { sprite, weapon, hp, state... }
        this.walls =[]; // Геометрия уровня
        
        // Хост: система тиков
        this.currentTick = 0;
        this.lastTickTime = 0;

        // Клиент: интерполяция и предсказания
        this.localInputHistory =[];
        this.fovGraphics = null;
        this.tracersGraphics = null;
    }

    create() {
        // 1. Создаем границы мира
        this.physics.world.setBounds(0, 0, GAME_CONFIG.WORLD_BOUNDS.width, GAME_CONFIG.WORLD_BOUNDS.height);
        
        // Рендереры графики
        this.tracersGraphics = this.add.graphics();
        this.tracersGraphics.setDepth(10);
        
        // 2. Создаем стены (препятствия) - хардкод для MVP
        const wallsGroup = this.physics.add.staticGroup();
        this._createWall(wallsGroup, 800, 500, 400, 50);
        this._createWall(wallsGroup, 400, 800, 50, 400);
        this.walls = wallsGroup.getChildren();

        // 3. Создаем локального игрока (или хоста)
        this.spawnPlayer(this.myId, 500, 500);

        // 4. Подписка на сетевые события
        if (this.isHost) {
            this.network.onPlayerJoin = (id) => this.spawnPlayer(id, 600, 600);
            this.network.onPlayerLeave = (id) => this.removePlayer(id);
        } else {
            this.network.onStateUpdate = (stateData) => this.handleServerState(stateData);
        }

        // 5. Настройка камеры и тумана войны (Только для Клиента и Хоста-игрока)
        this.cameras.main.startFollow(this.players.get(this.myId).sprite);
        this.setupFoVMask();

        // Запускаем UI поверх
        this.scene.launch('UIScene');
    }

    _createWall(group, x, y, w, h) {
        const wall = this.add.rectangle(x, y, w, h, 0x555555);
        group.add(wall);
        return wall;
    }

    spawnPlayer(id, x, y) {
        // Создаем спрайт-круг (используем Arcade Physics)
        const color = id === this.myId ? 0x00ff00 : 0xff0000;
        const sprite = this.add.circle(x, y, GAME_CONFIG.PLAYER_RADIUS, color);
        this.physics.add.existing(sprite);
        sprite.body.setCollideWorldBounds(true);
        
        // Оружие
        const weapon = new WeaponState('AK47'); // Дефолтное оружие

        this.players.set(id, {
            id, sprite, weapon,
            hp: 100, isMoving: false, aimAngle: 0,
            targetX: x, targetY: y // Для клиентской интерполяции
        });

        // Коллизии со стенами
        this.physics.add.collider(sprite, this.walls);
    }

    removePlayer(id) {
        const player = this.players.get(id);
        if (player) {
            player.sprite.destroy();
            this.players.delete(id);
        }
    }

    // --- MAIN LOOP ---
    update(time, delta) {
        const uiScene = this.scene.get('UIScene');
        if (!uiScene || !uiScene.inputManager) return;

        // 1. Очистка временной графики (трассеры)
        this.tracersGraphics.clear();

        if (this.isHost) {
            this.hostTick(time, uiScene.inputManager);
        } else {
            this.clientTick(time, uiScene.inputManager);
        }

        // Обновление визуала (туман войны, поворот пушки)
        this.updateVisuals();
    }

    // --- HOST LOGIC (Авторитетный сервер) ---
    hostTick(time, inputManager) {
        // Ограничитель Tick Rate (30 раз в секунду)
        if (time - this.lastTickTime < NET_CONFIG.TICK_MS) return;
        this.currentTick++;
        this.lastTickTime = time;

        let tracersThisTick =[];

        // 1. Обработка локального инпута (Хост тоже играет)
        const hostInput = inputManager.createNetworkPacket(this.currentTick);
        this.applyInputToPlayer(this.myId, hostInput);
        tracersThisTick.push(...this.processShooting(this.myId, hostInput, time));

        // 2. Обработка входящих инпутов от клиентов
        for (const [peerId, queue] of this.network.clientInputQueue.entries()) {
            if (!this.players.has(peerId)) continue;
            
            // Берем последний актуальный инпут из очереди (для MVP простейший подход)
            if (queue.length > 0) {
                const latestInput = queue[queue.length - 1];
                this.applyInputToPlayer(peerId, latestInput);
                tracersThisTick.push(...this.processShooting(peerId, latestInput, time));
                
                // Очищаем очередь
                this.network.clientInputQueue.set(peerId,[]); 
            }
        }

        // 3. Расчет FoV и Рассылка State (Анти-Валлхак)
        // Для каждого клиента формируем индивидуальный пакет видимости
        for (const[peerId, conn] of this.network.clients.entries()) {
            const statePacket = this.buildStateForClient(peerId, time, tracersThisTick);
            this.network.sendToClient(peerId, statePacket);
        }
    }

    buildStateForClient(targetClientId, time, tracers) {
        const targetPlayer = this.players.get(targetClientId);
        if (!targetPlayer) return [];

        const myData =[
            targetPlayer.sprite.x,
            targetPlayer.sprite.y,
            targetPlayer.hp,
            targetPlayer.aimAngle
        ];

        const enemiesData =[];
        
        // Проверка видимости всех остальных (Анти-Валлхак)
        for (const [otherId, otherPlayer] of this.players.entries()) {
            if (otherId === targetClientId) continue;

            // Математика Raycasting / конуса видимости (упрощенно)
            if (this.checkLineOfSight(targetPlayer, otherPlayer)) {
                enemiesData.push([
                    otherId,
                    Math.round(otherPlayer.sprite.x),
                    Math.round(otherPlayer.sprite.y),
                    otherPlayer.hp
                ]);
            }
        }

        // Формат: [tick, timestamp, [my_x, my_y, hp, aim], [[en_id, x, y, hp]...], [[tracer_x1,y1,x2,y2]...]]
        return [this.currentTick, time, myData, enemiesData, tracers];
    }

    // --- CLIENT LOGIC ---
    clientTick(time, inputManager) {
        // 1. CLIENT-SIDE PREDICTION (Мгновенный отклик)
        const input = inputManager.createNetworkPacket(this.currentTick);
        this.applyInputToPlayer(this.myId, input);
        
        // Сохраняем историю для Server Reconciliation (сверки с хостом)
        this.localInputHistory.push({ tick: this.currentTick, input: input, x: this.players.get(this.myId).sprite.x, y: this.players.get(this.myId).sprite.y });
        
        // Отправляем на сервер
        this.network.sendInput(input);
        this.currentTick++;

        // 2. ИНТЕРПОЛЯЦИЯ ЧУЖИХ ИГРОКОВ
        this.interpolateEntities();
    }

    handleServerState(data) {
        const[serverTick, timestamp, myData, enemiesData, tracers] = data;
        const myPlayer = this.players.get(this.myId);

        // 1. SERVER RECONCILIATION
        // Удаляем из истории все инпуты, которые Хост уже обработал
        this.localInputHistory = this.localInputHistory.filter(h => h.tick > serverTick);
        
        // Проверяем десинхронизацию
        const dx = Math.abs(myPlayer.sprite.x - myData[0]);
        const dy = Math.abs(myPlayer.sprite.y - myData[1]);
        
        if (dx > 5 || dy > 5) {
            // Если мы разошлись с сервером больше чем на 5 пикселей — жестко корректируем
            myPlayer.sprite.x = myData[0];
            myPlayer.sprite.y = myData[1];
            
            // Перепроигрываем локальные инпуты, которые сервер еще не видел
            for (let historyItem of this.localInputHistory) {
                this.applyInputToPlayer(this.myId, historyItem.input);
            }
        }

        // 2. ОБНОВЛЕНИЕ ДАННЫХ ВРАГОВ (для интерполяции)
        for (let enemy of enemiesData) {
            let [id, ex, ey, ehp] = enemy;
            if (!this.players.has(id)) this.spawnPlayer(id, ex, ey);
            
            const p = this.players.get(id);
            p.hp = ehp;
            // Не применяем координаты сразу! Записываем в target для плавного движения (Lerp)
            p.targetX = ex;
            p.targetY = ey;
        }

        // 3. ОТРИСОВКА ПОЛУЧЕННЫХ ТРАССЕРОВ
        this.drawTracers(tracers);
    }

    interpolateEntities() {
        // Линейная интерполяция (Lerp) для всех врагов
        for (const [id, player] of this.players.entries()) {
            if (id === this.myId) continue;
            
            // Плавно подтягиваем спрайт к target координатам
            player.sprite.x = Phaser.Math.Linear(player.sprite.x, player.targetX, 0.2);
            player.sprite.y = Phaser.Math.Linear(player.sprite.y, player.targetY, 0.2);
        }
    }

    // --- ОБЩАЯ ФИЗИКА И МАТЕМАТИКА ---
    applyInputToPlayer(id, inputData) {
        const[tick, mX, mY, aimAngle, isShooting] = inputData;
        const player = this.players.get(id);
        if (!player) return;

        player.aimAngle = aimAngle;
        player.isMoving = (mX !== 0 || mY !== 0);

        // Применяем скорость (Arcade Physics Velocity)
        player.sprite.body.setVelocity(
            mX * GAME_CONFIG.PLAYER_SPEED,
            mY * GAME_CONFIG.PLAYER_SPEED
        );
    }

    processShooting(id, inputData, time) {
        const[tick, mX, mY, aimAngle, isShooting] = inputData;
        if (!isShooting) return[];

        const player = this.players.get(id);
        const tracersOut =[];

        const result = player.weapon.fire(time, {
            x: player.sprite.x,
            y: player.sprite.y,
            aimAngle: aimAngle,
            isMoving: player.isMoving
        }, (startX, startY, endX, endY) => {
            // Callback Hitscan'а
            return this.raycastWorld(startX, startY, endX, endY, id);
        });

        if (result) {
            tracersOut.push([result.tracer.startX, result.tracer.startY, result.tracer.endX, result.tracer.endY]);
            
            // Если попали во врага — наносим урон (Авторитетно)
            if (result.hit && result.hit.type === 'player' && this.isHost) {
                const targetPlayer = this.players.get(result.hit.id);
                targetPlayer.hp -= result.damage;
                if (targetPlayer.hp <= 0) {
                    console.log(`Player ${result.hit.id} killed by ${id}`);
                    // Тут логика респавна
                    targetPlayer.hp = 100;
                    targetPlayer.sprite.setPosition(200, 200); 
                }
            }
        }

        return tracersOut;
    }

    raycastWorld(x1, y1, x2, y2, shooterId) {
        const line = new Phaser.Geom.Line(x1, y1, x2, y2);
        let closestIntersection = null;
        let minDistance = Infinity;
        let hitTarget = null;

        // 1. Проверка пересечения со стенами
        for (let wall of this.walls) {
            const rect = wall.getBounds();
            // Получаем точки пересечения линии и AABB (прямоугольника)
            const pts = Phaser.Geom.Intersects.GetLineToRectangle(line, rect);
            if (pts.length > 0) {
                const dist = Phaser.Math.Distance.Between(x1, y1, pts[0].x, pts[0].y);
                if (dist < minDistance) {
                    minDistance = dist;
                    closestIntersection = pts[0];
                    hitTarget = { type: 'wall' };
                }
            }
        }

        // 2. Проверка пересечения с другими игроками
        for (const [id, player] of this.players.entries()) {
            if (id === shooterId) continue;
            
            const circle = new Phaser.Geom.Circle(player.sprite.x, player.sprite.y, GAME_CONFIG.PLAYER_RADIUS);
            // Простейшая проверка: пересекает ли луч окружность игрока
            if (Phaser.Geom.Intersects.LineToCircle(line, circle)) {
                const dist = Phaser.Math.Distance.Between(x1, y1, player.sprite.x, player.sprite.y);
                if (dist < minDistance) {
                    minDistance = dist;
                    closestIntersection = { x: player.sprite.x, y: player.sprite.y };
                    hitTarget = { type: 'player', id: id };
                }
            }
        }

        if (closestIntersection) {
            return { x: closestIntersection.x, y: closestIntersection.y, target: hitTarget };
        }
        return null;
    }

    // --- VISUALS & FIELD OF VIEW ---
    // --- VISUALS & FIELD OF VIEW ---
    setupFoVMask() {
        // 1. Создаем объект графики, который будет работать как "трафарет" (он невидим)
        this.maskGraphics = this.make.graphics();
        
        // 2. Создаем огромный черный прямоугольник (Туман войны)
        this.fogOfWar = this.add.rectangle(
            0, 0, 
            GAME_CONFIG.WORLD_BOUNDS.width, 
            GAME_CONFIG.WORLD_BOUNDS.height, 
            0x000000, 0.95
        ).setOrigin(0, 0); // Ставим якорь в верхний левый угол мира
        
        this.fogOfWar.setDepth(100); // Поверх всего мира
        
        // 3. Создаем маску из нашего трафарета и ИНВЕРТИРУЕМ её (чтобы конус стирал черноту)
        const mask = this.maskGraphics.createGeometryMask();
        mask.setInvertAlpha(true);
        this.fogOfWar.setMask(mask);
    }

    updateVisuals() {
        const myPlayer = this.players.get(this.myId);
        if (!myPlayer) return;

        // 1. Очищаем старый трафарет
        this.maskGraphics.clear();
        
        // 2. Рисуем конус видимости (белым цветом, цвет здесь не важен, важна форма)
        this.maskGraphics.fillStyle(0xffffff, 1);
        this.maskGraphics.beginPath();
        this.maskGraphics.moveTo(myPlayer.sprite.x, myPlayer.sprite.y);
        
        const halfFov = GAME_CONFIG.FOV_ANGLE / 2;
        this.maskGraphics.arc(
            myPlayer.sprite.x, myPlayer.sprite.y, 
            800, // Дальность света (в пикселях)
            myPlayer.aimAngle - halfFov, 
            myPlayer.aimAngle + halfFov, 
            false
        );
        this.maskGraphics.fillPath();

        // 3. Вращение самого спрайта игрока в сторону прицела (опционально)
        myPlayer.sprite.rotation = myPlayer.aimAngle;
    };
        this.fovGraphics.fillPath();
        this.fovGraphics.globalCompositeOperation = 'source-over'; // Возвращаем режим рендера

        // 2. Вращение спрайтов к углу прицела (Опционально, если есть текстуры)
        // myPlayer.sprite.rotation = myPlayer.aimAngle;
    }

    drawTracers(tracers) {
        if (!tracers || tracers.length === 0) return;
        
        this.tracersGraphics.lineStyle(2, 0xffaa00, 1);
        for (let t of tracers) {
            this.tracersGraphics.beginPath();
            this.tracersGraphics.moveTo(t[0], t[1]);
            this.tracersGraphics.lineTo(t[2], t[3]);
            this.tracersGraphics.strokePath();
        }
    }

    // --- UTILS ---
    checkLineOfSight(playerA, playerB) {
        // 1. Проверка дистанции
        const dist = Phaser.Math.Distance.Between(playerA.sprite.x, playerA.sprite.y, playerB.sprite.x, playerB.sprite.y);
        if (dist > 800) return false;

        // 2. Проверка угла видимости (внутри конуса 120 градусов)
        const angleToTarget = Phaser.Math.Angle.Between(playerA.sprite.x, playerA.sprite.y, playerB.sprite.x, playerB.sprite.y);
        const angleDiff = Phaser.Math.Angle.Wrap(angleToTarget - playerA.aimAngle);
        if (Math.abs(angleDiff) > GAME_CONFIG.FOV_ANGLE / 2) return false;

        // 3. Raycast на препятствия (стены)
        const hit = this.raycastWorld(playerA.sprite.x, playerA.sprite.y, playerB.sprite.x, playerB.sprite.y, playerA.id);
        // Если луч уперся в стену до того, как дошел до игрока B
        if (hit && hit.target && hit.target.type === 'wall') return false;

        return true;
    }
}

// --- INITIALIZATION ---
// Простейший UI выбор при старте игры
const isHostChoice = confirm("Start as HOST? (Cancel for Client)");
const network = new NetworkManager();

if (isHostChoice) {
    network.initAsHost().then((id) => {
        alert("You are Host! Room ID (copy to client): " + id);
        startGame();
    });
} else {
    const hostId = prompt("Enter Host Room ID:");
    network.initAsClient(hostId).then(() => startGame());
}

function startGame() {
    const config = {
        type: Phaser.WEBGL,
        scale: {
            mode: Phaser.Scale.RESIZE,
            parent: 'game-container',
            width: '100%',
            height: '100%'
        },
        physics: {
            default: 'arcade',
            arcade: { debug: false }
        },
        // --- ВОТ ЭТОТ БЛОК Я ЗАБЫЛ ДОБАВИТЬ ---
        plugins: {
            global:[{
                key: 'rexVirtualJoystick',
                plugin: window.rexvirtualjoystickplugin, // Берем плагин из глобальной области (подключен в HTML)
                start: true
            }]
        },
        // --------------------------------------
        scene: [GameScene, UIScene]
    };

    const game = new Phaser.Game(config);
    // Прокидываем NetworkManager в GameScene
    game.scene.start('GameScene', { network: network });
}
