/**
 * @file weapons.js
 * @description Логика оружия, стрельбы, математика разброса (Spread) и Hitscan
 */

import { WEAPONS } from './config.js';

export default class WeaponState {
    /**
     * @param {string} weaponId - ID оружия из конфига (например, 'AK47')
     */
    constructor(weaponId) {
        this.config = WEAPONS[weaponId];
        
        // Состояние
        this.ammo = this.config.magazineSize;
        this.lastFireTime = 0;
        this.continuousShots = 0;
        this.isReloading = false;
        this.reloadEndTime = 0;
    }

    /**
     * Попытка выстрела
     * Вызывается на Хосте для обработки авторитетной физики и на Клиенте для локальных эффектов
     * 
     * @param {number} currentTime - Текущее время (Date.now() или scene.time.now)
     * @param {Object} playerState - { x, y, aimAngle, isMoving }
     * @param {Function} raycastCallback - Функция проверки пересечений луча с картой/игроками (hitscan)
     * @returns {Object|null} Результат выстрела (tracer data, hit info) или null
     */
    fire(currentTime, playerState, raycastCallback) {
        // Проверка кулдауна между выстрелами
        if (currentTime - this.lastFireTime < this.config.fireRate) return null;
        
        // Проверка перезарядки
        if (this.isReloading) {
            if (currentTime >= this.reloadEndTime) {
                this.isReloading = false;
                this.ammo = this.config.magazineSize;
            } else {
                return null;
            }
        }

        // Проверка патронов
        if (this.ammo <= 0) {
            this.reload(currentTime);
            return null;
        }

        // Сброс штрафа за зажим, если игрок делал паузу (отпустил курок на время > fireRate * 2.5)
        if (currentTime - this.lastFireTime > this.config.fireRate * 2.5) {
            this.continuousShots = 0;
        }

        // 1. Потребление патрона
        this.ammo--;
        this.lastFireTime = currentTime;
        this.continuousShots++;

        // 2. Вычисление вектора пули с учетом Spread
        const bulletVector = this._calculateSpreadVector(playerState.aimAngle, playerState.isMoving);

        // 3. Вычисление конечной точки луча (Hitscan)
        const startX = playerState.x;
        const startY = playerState.y;
        const maxEndX = startX + bulletVector.x * this.config.range;
        const maxEndY = startY + bulletVector.y * this.config.range;

        // 4. Выполняем Raycast (делегируем в игровую логику / физический движок)
        // raycastCallback должна вернуть точку столкновения (если есть) и объект, в который попали
        const hitResult = raycastCallback(startX, startY, maxEndX, maxEndY);

        const endX = hitResult ? hitResult.x : maxEndX;
        const endY = hitResult ? hitResult.y : maxEndY;

        return {
            tracer: { startX, startY, endX, endY },
            hit: hitResult ? hitResult.target : null,
            damage: this.config.damage
        };
    }

    /**
     * Запуск перезарядки
     * @param {number} currentTime 
     */
    reload(currentTime) {
        if (this.isReloading || this.ammo === this.config.magazineSize) return;
        this.isReloading = true;
        this.reloadEndTime = currentTime + this.config.reloadTime;
    }

    /**
     * Внутренняя функция вычисления вектора (реализация математики разброса)
     * @private
     */
    _calculateSpreadVector(aimAngle, isMoving) {
        let currentSpread = this.config.baseSpread;
        
        if (isMoving) {
            currentSpread += this.config.movePenalty;
        }
        
        const firePenalty = this.continuousShots * this.config.continuousFirePenalty;
        currentSpread = Math.min(currentSpread + firePenalty, this.config.maxSpread);

        const randomDeviation = (Math.random() * 2 - 1) * currentSpread;
        const finalAngle = aimAngle + randomDeviation;

        return {
            x: Math.cos(finalAngle),
            y: Math.sin(finalAngle)
        };
    }
}
