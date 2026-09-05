"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KeepLive = exports.Live = exports.relayEvent = void 0;
const events_1 = require("events");
const buffer_1 = require("./buffer");
exports.relayEvent = Symbol('relay');
class NiceEventEmitter extends events_1.EventEmitter {
    emit(eventName, ...params) {
        super.emit(eventName, ...params);
        super.emit(exports.relayEvent, eventName, ...params);
        return true;
    }
}
class Live extends NiceEventEmitter {
    constructor(inflates, roomid, { send, close, protover = 2, key, authBody, uid = 0, buvid }) {
        if (typeof roomid !== 'number' || Number.isNaN(roomid)) {
            throw new Error(`roomid ${roomid} must be Number not NaN`);
        }
        super();
        this.inflates = inflates;
        this.roomid = roomid;
        this.online = 0;
        this.live = false;
        this.closed = false;
        this.timeout = setTimeout(() => { }, 0);
        this.send = send;
        this.close = () => {
            this.closed = true;
            close();
        };
        this.on('message', async (buffer) => {
            const packs = await (0, buffer_1.makeDecoder)(inflates)(buffer);
            packs.forEach(({ type, data }) => {
                if (type === 'welcome') {
                    this.live = true;
                    this.emit('live');
                    this.send((0, buffer_1.encoder)('heartbeat', inflates));
                }
                if (type === 'heartbeat') {
                    this.online = data;
                    clearTimeout(this.timeout);
                    this.timeout = setTimeout(() => this.heartbeat(), 1000 * 30);
                    this.emit('heartbeat', this.online);
                }
                if (type === 'message') {
                    this.emit('msg', data);
                    const cmd = data.cmd || (data.msg && data.msg.cmd);
                    if (cmd) {
                        if (cmd.includes('DANMU_MSG')) {
                            this.emit('DANMU_MSG', data);
                        }
                        else {
                            this.emit(cmd, data);
                        }
                    }
                }
            });
        });
        this.on('open', () => {
            if (authBody) {
                if (typeof authBody === 'object') {
                    authBody = (0, buffer_1.encoder)('join', inflates, authBody);
                }
                this.send(authBody);
            }
            else {
                const hi = { uid: uid, roomid, protover, platform: 'web', type: 2 };
                if (key) {
                    hi.key = key;
                }
                if (buvid) {
                    hi.buvid = buvid;
                }
                const buf = (0, buffer_1.encoder)('join', inflates, hi);
                this.send(buf);
            }
        });
        this.on('close', () => {
            clearTimeout(this.timeout);
        });
        this.on('_error', error => {
            this.close();
            this.emit('error', error);
        });
    }
    heartbeat() {
        this.send((0, buffer_1.encoder)('heartbeat', this.inflates));
    }
    getOnline() {
        this.heartbeat();
        return new Promise(resolve => this.once('heartbeat', resolve));
    }
}
exports.Live = Live;
class KeepLive extends events_1.EventEmitter {
    constructor(Base, ...params) {
        super();
        this.params = params;
        this.closed = false;
        this.interval = 100;
        this.timeout = 45 * 1000;
        this.connection = new Base(...this.params);
        this.Base = Base;
        this.connect(false);
    }
    connect(reconnect = true) {
        if (reconnect) {
            this.connection.close();
            this.connection = new this.Base(...this.params);
        }
        const connection = this.connection;
        let timeout = setTimeout(() => {
            connection.close();
            connection.emit('timeout');
        }, this.timeout);
        connection.on(exports.relayEvent, (eventName, ...params) => {
            if (eventName !== 'error') {
                this.emit(eventName, ...params);
            }
        });
        connection.on('error', (e) => this.emit('e', e));
        connection.on('close', () => {
            if (!this.closed) {
                setTimeout(() => this.connect(), this.interval);
            }
        });
        connection.on('heartbeat', () => {
            clearTimeout(timeout);
            timeout = setTimeout(() => {
                connection.close();
                connection.emit('timeout');
            }, this.timeout);
        });
        connection.on('close', () => {
            clearTimeout(timeout);
        });
    }
    get online() {
        return this.connection.online;
    }
    get roomid() {
        return this.connection.roomid;
    }
    close() {
        this.closed = true;
        this.connection.close();
    }
    heartbeat() {
        return this.connection.heartbeat();
    }
    getOnline() {
        return this.connection.getOnline();
    }
    send(data) {
        return this.connection.send(data);
    }
}
exports.KeepLive = KeepLive;
