/**
 * @file input.js
 * @description Обработка Twin-Stick управления (Mobile)
 */

export default class InputManager {
    /**
     * @param {Phaser.Scene} uiScene - Отдельная сцена для UI (поверх игровой)
     */
    constructor(uiScene) {
        this.scene = uiScene;
        
        // Получаем скачанный плагин по ключу
        const joystickPlugin = this.scene.plugins.get('rexvirtualjoystickplugin');
        
        // Левый стик (Движение)
        this.moveStick = joystickPlugin.add(this.scene, {
            x: 120,
            y: this.scene.scale.height - 120,
            radius: 80,
            base: this.scene.add.circle(0, 0, 80, 0x888888, 0.5),
            thumb: this.scene.add.circle(0, 0, 40, 0xcccccc, 0.8),
            dir: '8dir',
            forceMin: 15
        });

        // Правый стик (Прицеливание и стрельба)
        this.aimStick = joystickPlugin.add(this.scene, {
            x: this.scene.scale.width - 120,
            y: this.scene.scale.height - 120,
            radius: 80,
            base: this.scene.add.circle(0, 0, 80, 0x888888, 0.5),
            thumb: this.scene.add.circle(0, 0, 40, 0xcc0000, 0.8),
            dir: '8dir',
            forceMin: 15 // Мертвая зона в центре стика
        });

        // Обработка ресайза окна для смещения джойстиков
        this.scene.scale.on('resize', this.handleResize, this);
    }

    handleResize(gameSize) {
        const width = gameSize.width;
        const height = gameSize.height;
        
        this.moveStick.setPosition(120, height - 120);
        this.aimStick.setPosition(width - 120, height - 120);
    }

    /**
     * Получить вектор перемещения левого стика
     * @returns {Object} {x, y} нормализованный вектор
     */
    getMovementVector() {
        if (!this.moveStick.force) return { x: 0, y: 0 };
        
        // rexVirtualJoystick отдает нормализованные forceX/forceY если мы попросим,
        // но надежнее взять угол и посчитать
        const angle = this.moveStick.rotation; // в радианах
        return {
            x: Math.cos(angle),
            y: Math.sin(angle)
        };
    }

    /**
     * Получить данные правого стика (прицеливание и флаг стрельбы)
     * @returns {Object} {aimAngle, isShooting}
     */
    getAimData() {
        let isShooting = false;
        let aimAngle = 0;

        if (this.aimStick.force) {
            aimAngle = this.aimStick.rotation;
            // Если отклонение стика > 50% от радиуса (40 пикселей из 80), начинаем стрельбу
            if (this.aimStick.force > (this.aimStick.radius * 0.5)) {
                isShooting = true;
            }
        }

        return { aimAngle, isShooting };
    }

    /**
     * Формирует пакет инпутов для отправки по сети/применения локально
     * @param {number} tick - текущий сетевой тик
     * @returns {Array} Пакет:[tick, inputX, inputY, aimAngle, isShooting]
     */
    createNetworkPacket(tick) {
        const move = this.getMovementVector();
        const aim = this.getAimData();
        
        // Округляем до 3 знаков для экономии трафика (можно оптимизировать до битовых масок позже)
        const round = (val) => Math.round(val * 1000) / 1000;

        return[
            tick,
            round(move.x),
            round(move.y),
            round(aim.aimAngle),
            aim.isShooting ? 1 : 0
        ];
    }
}
