"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const MongoDB_1 = require("./MongoDB");
const PromiseUtils_1 = require("./Utils/PromiseUtils");
class ListManager {
    constructor(core) {
        core.on("init", _ => {
            this.audioManager = core.audioManager;
        });
        core.on("ready", () => {
            if (!this.audioManager)
                throw Error("AudioManager not init");
            if (!core.database.client)
                throw Error("Database client not init");
            this.database = core.database.client.collection("list");
            this.database.findOneAndUpdate({ admin: { $type: 10 } }, { $set: { admin: [] } });
            this.database.createIndex({ owner: 1 });
            this.database.createIndex({ admin: 1 });
        });
    }
    async create(name, owner) {
        if (!this.database)
            throw MongoDB_1.ERR_DB_NOT_INIT;
        return (await this.database.insertOne({
            admin: Array(),
            audio: Array(),
            name,
            owner
        })).ops[0];
    }
    get(id) {
        if (!this.database)
            throw MongoDB_1.ERR_DB_NOT_INIT;
        return PromiseUtils_1.retry(() => this.database.findOne({ _id: id }), 17280, 5000, false);
    }
    getAll() {
        if (!this.database)
            throw MongoDB_1.ERR_DB_NOT_INIT;
        return this.database.find();
    }
    getFromPermission(user) {
        if (!this.database)
            throw MongoDB_1.ERR_DB_NOT_INIT;
        return this.database.find({ $or: [{ owner: user }, { admin: user }] });
    }
    async rename(id, name) {
        if (!this.database)
            throw MongoDB_1.ERR_DB_NOT_INIT;
        return (await this.database.findOneAndUpdate({ _id: id }, { $set: { name } }, { returnOriginal: false })).value;
    }
    async delete(id) {
        if (!this.database)
            throw MongoDB_1.ERR_DB_NOT_INIT;
        this.database.deleteOne({ _id: id });
    }
    async addAdmin(id, admin) {
        if (!this.database)
            throw MongoDB_1.ERR_DB_NOT_INIT;
        return (await this.database.findOneAndUpdate({ _id: id }, { $addToSet: { admin } }, { returnOriginal: false })).value;
    }
    async removeAdmin(id, admin) {
        if (!this.database)
            throw MongoDB_1.ERR_DB_NOT_INIT;
        return (await this.database.findOneAndUpdate({ _id: id }, { $pull: { admin } }, { returnOriginal: false })).value;
    }
    async addAudio(id, audio) {
        if (!this.database)
            throw MongoDB_1.ERR_DB_NOT_INIT;
        return (await this.database.findOneAndUpdate({ _id: id }, { $addToSet: { audio } }, { returnOriginal: false })).value;
    }
    async delAudio(id, audio) {
        if (!this.database)
            throw MongoDB_1.ERR_DB_NOT_INIT;
        return (await this.database.findOneAndUpdate({ _id: id }, { $pull: { audio } }, { returnOriginal: false })).value;
    }
    async delAudioAll(audio) {
        if (!this.database)
            throw MongoDB_1.ERR_DB_NOT_INIT;
        return this.database.updateMany({}, { $pull: { audio } });
    }
    async checkAudioExist() {
        this.getAll().forEach(list => {
            list.audio.forEach(async (audio) => {
                if (!await this.audioManager.get(audio))
                    this.delAudioAll(audio);
            });
        });
    }
}
exports.ListManager = ListManager;
