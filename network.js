/**
 * @file network.js
 * @description Обертка над PeerJS. Управляет соединениями и буферизацией пакетов.
 */

import { NET_CONFIG } from './config.js';

export default class NetworkManager {
    constructor() {
        this.peer = null;
        this.isHost = false;
        
        // Host: соединения с клиентами { peerId: DataConnection }
        this.clients = new Map(); 
        
        // Client: соединение с хостом
        this.hostConnection = null; 

        // Буферы состояний
        this.clientInputQueue = new Map(); // Host: { peerId: [inputs...] }
        this.stateBuffer =[]; // Client: история состояний мира от Хоста (для интерполяции)
        
        this.onStateUpdate = null; // Callback для Клиента
        this.onPlayerJoin = null;  // Callback для Хоста
        this.onPlayerLeave = null; // Callback для Хоста
    }

    /**
     * Инициализация Хоста (Авторитетного сервера)
     */
    async initAsHost() {
        this.isHost = true;
        return new Promise((resolve, reject) => {
            // Оставляем ID пустым для автогенерации, либо можно задать кастомный
            this.peer = new window.Peer({ config: { iceServers: NET_CONFIG.PEER_STUN_SERVERS } });

            this.peer.on('open', (id) => {
                console.log('[HOST] Server started. Room ID:', id);
                resolve(id);
            });

            this.peer.on('connection', (conn) => {
                console.log(`[HOST] Client connected: ${conn.peer}`);
                this.clients.set(conn.peer, conn);
                this.clientInputQueue.set(conn.peer,[]);

                if (this.onPlayerJoin) this.onPlayerJoin(conn.peer);

                conn.on('data', (data) => {
                    // Host получает инпуты от клиента и кладет в очередь
                    this.clientInputQueue.get(conn.peer).push(data);
                });

                conn.on('close', () => {
                    this.clients.delete(conn.peer);
                    this.clientInputQueue.delete(conn.peer);
                    if (this.onPlayerLeave) this.onPlayerLeave(conn.peer);
                });
            });

            this.peer.on('error', reject);
        });
    }

    /**
     * Инициализация Клиента
     * @param {string} hostId - ID пира Хоста
     */
    async initAsClient(hostId) {
        this.isHost = false;
        return new Promise((resolve, reject) => {
            this.peer = new window.Peer({ config: { iceServers: NET_CONFIG.PEER_STUN_SERVERS } });

            this.peer.on('open', (id) => {
                console.log('[CLIENT] Peer initialized. My ID:', id);
                
                this.hostConnection = this.peer.connect(hostId, { reliable: false }); // Отключаем TCP-like надежность для скорости
                
                this.hostConnection.on('open', () => {
                    console.log('[CLIENT] Connected to Host!');
                    resolve(id);
                });

                this.hostConnection.on('data', (data) => {
                    // Client получает World State:[tick, timestamp, myData, enemiesData, tracersData]
                    this.stateBuffer.push(data);
                    
                    // Храним только последние 20 состояний (защита от утечек памяти)
                    if (this.stateBuffer.length > 20) {
                        this.stateBuffer.shift();
                    }

                    if (this.onStateUpdate) this.onStateUpdate(data);
                });

                this.hostConnection.on('error', reject);
            });

            this.peer.on('error', reject);
        });
    }

    /**
     * Host: Отправить индивидуальный State конкретному клиенту
     */
    sendToClient(peerId, data) {
        const conn = this.clients.get(peerId);
        if (conn && conn.open) {
            conn.send(data);
        }
    }

    /**
     * Client: Отправить свои стики на Хост
     */
    sendInput(inputData) {
        if (this.hostConnection && this.hostConnection.open) {
            this.hostConnection.send(inputData);
        }
    }
}
