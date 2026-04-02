/**
 * @file config.js
 * @description Глобальные константы, параметры сети и баланс оружия
 */

export const NET_CONFIG = {
    TICK_RATE: 30, // Хост обрабатывает логику 30 раз в секунду
    TICK_MS: 1000 / 30, // Интервал в мс
    PEER_STUN_SERVERS:[
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

export const GAME_CONFIG = {
    PLAYER_SPEED: 200, // Пикселей в секунду
    PLAYER_RADIUS: 16, // Хитбокс
    FOV_ANGLE: Math.PI / 1.5, // Угол видимости (120 градусов)
    WORLD_BOUNDS: { width: 2000, height: 2000 }
};

/**
 * Конфигурация оружия.
 * Углы Spread указаны в радианах (Math.PI / 180 = 1 градус)
 */
export const WEAPONS = {
    AK47: {
        id: 'AK47',
        damage: 30,
        fireRate: 100, // мс между выстрелами
        baseSpread: 0.02, // ~1.1 градус
        movePenalty: 0.1, // сильный штраф за движение
        continuousFirePenalty: 0.015, // штраф за каждую пулю в зажиме
        maxSpread: 0.3,
        magazineSize: 30,
        reloadTime: 2500, // мс
        range: 1500 // Дальность hitscan'а (пиксели)
    },
    M4A1: {
        id: 'M4A1',
        damage: 25,
        fireRate: 90,
        baseSpread: 0.015,
        movePenalty: 0.05, // меньше штраф за движение, чем у AK
        continuousFirePenalty: 0.01,
        maxSpread: 0.2,
        magazineSize: 30,
        reloadTime: 2000,
        range: 1500
    },
    AWP: {
        id: 'AWP',
        damage: 100,
        fireRate: 1200, // Снайперская винтовка, долгое передергивание затвора
        baseSpread: 0.0, // Идеальная точность стоя
        movePenalty: 0.5, // Огромный штраф при ходьбе (No-scope на ходу почти невозможен)
        continuousFirePenalty: 0.0,
        maxSpread: 0.5,
        magazineSize: 10,
        reloadTime: 3000,
        range: 3000
    },
    GLOCK: {
        id: 'GLOCK',
        damage: 15,
        fireRate: 150, // Полуавтомат (будет зависеть от клика, но есть лимит)
        baseSpread: 0.03,
        movePenalty: 0.02, // Легко стрелять на ходу
        continuousFirePenalty: 0.005,
        maxSpread: 0.15,
        magazineSize: 20,
        reloadTime: 1500,
        range: 800
    }
};
