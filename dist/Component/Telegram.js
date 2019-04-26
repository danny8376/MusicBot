"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mongodb_1 = require("mongodb");
const node_telegram_bot_api_1 = __importDefault(require("node-telegram-bot-api"));
const path_1 = require("path");
const promise_queue_1 = __importDefault(require("promise-queue"));
const url_1 = require("url");
const AudioManager_1 = require("../Core/AudioManager");
const PromiseUtils_1 = require("../Core/Utils/PromiseUtils");
exports.BIND_TYPE = "telegram";
const ERR_MISSING_TOKEN = Error("Telegram bot api token not found!");
const ERR_NOT_VALID_TITLE = Error("Not valid title");
const ERR_LIST_NOT_FOUND = Error("Playlist not found");
const ERR_NOT_REGISTER = "Please use /register to register or bind account!";
class Telegram {
    constructor(core) {
        this.messageQueue = new promise_queue_1.default(1);
        this.audioAddSession = new Map();
        if (!core.config.telegram.token)
            throw ERR_MISSING_TOKEN;
        this.user = core.userManager;
        this.audio = core.audioManager;
        this.list = core.listManager;
        this.bot = new node_telegram_bot_api_1.default(core.config.telegram.token, {
            polling: true,
        });
        this.audio.urlParser.registerURLHandler("^tg://", this.getFile.bind(this));
        this.audio.urlParser.registerMetadataProvider("^tg://", this.getMetadata.bind(this));
        this.bot.getMe().then(me => {
            this.me = me;
            this.listener();
        });
    }
    async listener() {
        this.bot.onText(/^\/(\w+)@?(\w*)/i, async (msg, match) => {
            if (!match || msg.chat.type !== "private" && match[2] !== this.me.username)
                return;
            switch (match[1]) {
                case "register":
                    this.commandRegister(msg);
                    break;
                case "bind":
                    this.commandBind(msg);
                    break;
                case "info":
                    this.commandInfo(msg);
                    break;
                case "list":
                    this.commandShowList(msg);
                    break;
            }
        });
        this.bot.on("audio", msg => this.processAudio(msg));
        this.bot.on("document", msg => this.processFile(msg));
        this.bot.on("text", async (msg) => {
            if (msg.entities && msg.entities.some(entity => entity.type.match(/url|text_link/ig) != null)) {
                this.sendProcessing(msg);
                for (const entity of msg.entities) {
                    if (entity.type === "url" && msg.text) {
                        this.processLink(msg, msg.text.substr(entity.offset, entity.length));
                    }
                    if (entity.type === "text_link" && entity.url) {
                        this.processLink(msg, entity.url);
                    }
                }
            }
        });
        this.bot.onText(/^([0-9a-f]{24})$/i, async (msg, match) => {
            const session = this.audioAddSession.get(msg.chat.id);
            if (!session || !match)
                return;
            const audio = await this.audio.get(new mongodb_1.ObjectID(match[1]));
            if (!audio) {
                this.queueSendMessage(msg.chat.id, "Sound ID not found in database", { reply_to_message_id: msg.message_id });
                return;
            }
            this.list.addAudio(session, audio._id);
            this.queueSendMessage(msg.chat.id, "Added to list!", { reply_to_message_id: msg.message_id });
        });
        this.bot.on("callback_query", async (query) => {
            if (!query.data)
                return;
            const data = query.data.split(" ");
            switch (data[0]) {
                case "AudioInfo":
                    this.audioInfoCallback(query, data);
                    break;
                case "List":
                    await this.playlistCallback(query, data);
                    break;
                case "ListInfo":
                    await this.listInfoCallback(query, data);
                    break;
                case "ListCreate":
                    await this.listCreateCallback(query, data);
                    break;
                case "ListAudioAdd":
                    await this.listAudioAddCallback(query, data);
                    break;
                case "ListAudioDel":
                    await this.listAudioDeleteCallback(query, data);
                    break;
                case "ListAudio":
                    await this.listAudioCallback(query, data);
                    break;
                case "ListSwitch":
                    await this.listSwitch(query, data);
                    break;
                case "ListAdminAdd":
                    await this.listAdminAddCallback(query, data);
                    break;
                case "ListAdminRemove":
                    await this.listAdminRemoveCallback(query, data);
                    break;
                case "ListRename":
                    await this.listRenameCallback(query, data);
                    break;
                case "ListDelete":
                    await this.listDeleteCallback(query, data);
                    break;
                default:
                    this.bot.answerCallbackQuery(query.id);
            }
        });
        this.bot.on("error", err => console.error(err));
    }
    async commandRegister(msg) {
        if (!msg.from || !msg.text)
            return;
        const args = msg.text.split(" ");
        try {
            if (args.length > 1) {
                await this.user.createFromToken(args[1], { type: exports.BIND_TYPE, id: msg.from.id });
            }
            else {
                await this.user.create(msg.from.username || msg.from.id.toString(), { type: exports.BIND_TYPE, id: msg.from.id });
            }
        }
        catch (error) {
            this.sendError(msg, error.message);
            return;
        }
        this.commandInfo(msg);
    }
    async commandBind(msg) {
        if (!msg.from)
            return;
        const user = await this.getUser(msg.from.id);
        if (!user) {
            this.sendError(msg, ERR_NOT_REGISTER);
            return;
        }
        this.queueSendMessage(msg.chat.id, `Register token: ${this.user.createBindToken(user._id)}\nExpires after one hour`);
    }
    async commandInfo(msg) {
        if (!msg.from)
            return;
        const user = await this.user.get(exports.BIND_TYPE, msg.from.id);
        if (!user) {
            this.queueSendMessage(msg.chat.id, ERR_NOT_REGISTER);
        }
        else {
            this.queueSendMessage(msg.chat.id, `ID: ${user._id}\nName: ${user.name}\nBind: ${user.bind.map(i => `${i.type}(${i.id})`).join(", ")}`);
        }
    }
    async commandShowList(msg) {
        if (!msg.from || !msg.text)
            return;
        const args = msg.text.split(" ");
        const user = await this.getUser(msg.from.id);
        if (!user) {
            this.sendError(msg, ERR_NOT_REGISTER);
            return;
        }
        let view;
        if (args[1] && args[1].toLocaleLowerCase() === "all") {
            view = await this.genPlaylistView();
        }
        else {
            view = await this.genPlaylistView(0, user._id);
        }
        if (view.button) {
            this.queueSendMessage(msg.chat.id, view.text, { reply_markup: { inline_keyboard: view.button } });
        }
        else {
            this.queueSendMessage(msg.chat.id, view.text);
        }
    }
    async audioInfoCallback(query, data) {
        if (!query.message || !data[1])
            return;
        const audio = await this.audio.get(new mongodb_1.ObjectID(data[1]));
        if (!audio)
            return;
        this.bot.editMessageText(`ID: ${audio._id}\nTitle: ${audio.title}`, { chat_id: query.message.chat.id, message_id: query.message.message_id });
    }
    async playlistCallback(query, data) {
        if (!query.message)
            return;
        const view = await ((data[1]) ? this.genPlaylistView(parseInt(data[2], 10), new mongodb_1.ObjectID(data[1])) : this.genPlaylistView(parseInt(data[2], 10)));
        this.bot.editMessageText(view.text, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            reply_markup: { inline_keyboard: view.button }
        });
    }
    async listInfoCallback(query, data) {
        if (!query.message)
            return;
        const user = await this.getUser(query.from.id);
        if (!user)
            return;
        const view = await this.genListInfoView(new mongodb_1.ObjectID(data[1]), user._id);
        const options = {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            reply_markup: { inline_keyboard: view.button }
        };
        this.bot.editMessageText(view.text, options);
    }
    async listSwitch(query, data) {
        if (!query.message)
            return;
        const user = await this.getUser(query.from.id);
        if (!user)
            return;
        const view = await this.genPlaylistView(0, user._id, (data[1] === "Admin"));
        const options = {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            reply_markup: { inline_keyboard: view.button }
        };
        this.bot.editMessageText(view.text, options);
    }
    async listCreateCallback(query, data) {
        if (!query.message || !data[1])
            return;
        const user = await this.getUser(query.from.id);
        if (!user || !user._id.equals(new mongodb_1.ObjectID(data[1])))
            return;
        const message = await this.queueSendMessage(query.message.chat.id, "Enter name for new playlist", {
            reply_markup: {
                force_reply: true,
                selective: true
            }
        });
        if (message instanceof Error)
            throw message;
        this.bot.onReplyToMessage(message.chat.id, message.message_id, reply => {
            if (!reply.from || reply.from.id !== query.from.id)
                return;
            if (reply.text) {
                this.list.create(reply.text, user._id);
                this.queueSendMessage(reply.chat.id, "Success!", {
                    reply_to_message_id: reply.message_id
                });
            }
            else {
                this.queueSendMessage(reply.chat.id, "Invalid name!");
            }
            this.bot.removeReplyListener(message.message_id);
        });
        this.bot.answerCallbackQuery(query.id);
    }
    async listAudioAddCallback(query, data) {
        if (!query.message || !data[1])
            return;
        const list = await this.list.get(new mongodb_1.ObjectID(data[1]));
        const user = await this.getUser(query.from.id);
        if (!user || !list || !(list.owner.equals(user._id) || list.admin.find(id => id.equals(user._id))))
            return;
        if (data[2] === "done") {
            this.audioAddSession.delete(query.message.chat.id);
            this.bot.editMessageText("Now this list have " + list.audio.length + " sounds!", { chat_id: query.message.chat.id, message_id: query.message.message_id });
        }
        else {
            this.audioAddSession.set(query.message.chat.id, list._id);
            this.queueSendMessage(query.message.chat.id, "Send me audio file or sound ID you want add to list " + list.name, {
                reply_markup: { inline_keyboard: [[{ text: "Done", callback_data: `ListAudioAdd ${list._id.toHexString()} done` }]] }
            });
            this.bot.answerCallbackQuery(query.id);
        }
    }
    async listAudioDeleteCallback(query, data) {
        if (!query.message || data.length < 3)
            return;
        if (data[3]) {
            this.list.delAudio(new mongodb_1.ObjectID(data[1]), new mongodb_1.ObjectID(data[2]));
            this.bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: "Deleted", callback_data: "dummy" }]] }, { chat_id: query.message.chat.id, message_id: query.message.message_id });
        }
        else {
            const audioID = new mongodb_1.ObjectID(data[2]);
            const list = await this.list.get(new mongodb_1.ObjectID(data[1]));
            const audio = await this.audio.get(audioID);
            if (!list || !audio || !list.audio.find(id => id.equals(audioID)))
                return;
            this.bot.sendMessage(query.message.chat.id, `Are you sure delete ${audio.title} from list ${list.name}?`, {
                reply_markup: { inline_keyboard: [[{ text: "Yes", callback_data: `ListAudioDel ${data[1]} ${data[2]} y` }]] }
            });
            this.bot.answerCallbackQuery(query.id);
        }
    }
    async listAudioCallback(query, data) {
        if (!query.message || data.length < 3)
            return;
        const view = await this.genAudioListView(new mongodb_1.ObjectID(data[2]), parseInt(data[3], 10) || 0, data[1] === "delete");
        if (!view)
            return;
        if (view.button) {
            this.bot.editMessageText(view.text, {
                chat_id: query.message.chat.id,
                message_id: query.message.message_id,
                reply_markup: { inline_keyboard: view.button }
            });
        }
        else {
            this.bot.editMessageText(view.text, {
                chat_id: query.message.chat.id,
                message_id: query.message.message_id
            });
        }
    }
    async listAdminAddCallback(query, data) {
        if (!query.message || !data[1])
            return;
        const list = await this.list.get(new mongodb_1.ObjectID(data[1]));
        const user = await this.getUser(query.from.id);
        if (!user || !list || !list.owner.equals(user._id))
            return;
        const message = await this.queueSendMessage(query.message.chat.id, "Enter user's telegram id to add admin", {
            reply_markup: {
                force_reply: true,
                selective: true,
            }
        });
        if (message instanceof Error)
            throw message;
        this.bot.onReplyToMessage(message.chat.id, message.message_id, async (reply) => {
            if (!reply.from || reply.from.id !== query.from.id)
                return;
            if (reply.text) {
                if (parseInt(reply.text, 10) === reply.from.id) {
                    this.queueSendMessage(reply.chat.id, "You are adding your self!");
                }
                else {
                    const userToAdd = await this.getUser(parseInt(reply.text, 10));
                    if (!userToAdd) {
                        this.queueSendMessage(reply.chat.id, "User not found or not registered!");
                    }
                    else {
                        this.list.addAdmin(list._id, userToAdd._id);
                        this.queueSendMessage(reply.chat.id, "Success!", {
                            reply_to_message_id: reply.message_id
                        });
                    }
                }
            }
            else {
                this.queueSendMessage(reply.chat.id, "Invalid name!");
            }
            this.bot.answerCallbackQuery(query.id);
            this.bot.removeReplyListener(message.message_id);
        });
    }
    async listAdminRemoveCallback(query, data) {
        if (!query.message || !data[1])
            return;
        const list = await this.list.get(new mongodb_1.ObjectID(data[1]));
        const user = await this.getUser(query.from.id);
        if (!user || !list || !list.owner.equals(user._id))
            return;
        const message = await this.queueSendMessage(query.message.chat.id, "Enter user's telegram id to remove admin", {
            reply_markup: {
                force_reply: true,
                selective: true,
            }
        });
        if (message instanceof Error)
            throw message;
        this.bot.onReplyToMessage(message.chat.id, message.message_id, async (reply) => {
            if (!reply.from || reply.from.id !== query.from.id)
                return;
            if (reply.text) {
                if (parseInt(reply.text, 10) === reply.from.id) {
                    this.queueSendMessage(reply.chat.id, "You are removing your self!");
                }
                else {
                    const userToRemove = await this.getUser(parseInt(reply.text, 10));
                    if (!userToRemove) {
                        this.queueSendMessage(reply.chat.id, "User not found or not registered!");
                    }
                    else {
                        this.list.removeAdmin(list._id, userToRemove._id);
                        this.queueSendMessage(reply.chat.id, "Success!", {
                            reply_to_message_id: reply.message_id
                        });
                    }
                }
            }
            else {
                this.queueSendMessage(reply.chat.id, "Invalid name!");
            }
            this.bot.answerCallbackQuery(query.id);
            this.bot.removeReplyListener(message.message_id);
        });
    }
    async listRenameCallback(query, data) {
        if (!query.message || !data[1])
            return;
        const list = await this.list.get(new mongodb_1.ObjectID(data[1]));
        const user = await this.getUser(query.from.id);
        if (!user || !list || !list.owner.equals(user._id))
            return;
        const message = await this.queueSendMessage(query.message.chat.id, "Enter new name", {
            reply_markup: {
                force_reply: true,
                selective: true,
            }
        });
        if (message instanceof Error)
            throw message;
        this.bot.onReplyToMessage(message.chat.id, message.message_id, reply => {
            if (!reply.from || reply.from.id !== query.from.id)
                return;
            if (reply.text) {
                this.list.rename(list._id, reply.text);
                this.queueSendMessage(reply.chat.id, "Success!", {
                    reply_to_message_id: reply.message_id
                });
            }
            else {
                this.queueSendMessage(reply.chat.id, "Invalid name!");
            }
            this.bot.answerCallbackQuery(query.id);
            this.bot.removeReplyListener(message.message_id);
        });
    }
    async listDeleteCallback(query, data) {
        if (!query.message || !data[1])
            return;
        const list = await this.list.get(new mongodb_1.ObjectID(data[1]));
        const user = await this.getUser(query.from.id);
        if (!user || !list || !list.owner.equals(user._id))
            return;
        if (data[2]) {
            this.list.delete(new mongodb_1.ObjectID(data[1]));
            this.bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: "Deleted", callback_data: "dummy" }]] }, { chat_id: query.message.chat.id, message_id: query.message.message_id });
        }
        else {
            this.bot.sendMessage(query.message.chat.id, `Are you sure delete list ${list.name}?`, {
                reply_markup: { inline_keyboard: [[{ text: "Yes", callback_data: `ListDelete ${data[1]} y` }]] }
            });
            this.bot.answerCallbackQuery(query.id);
        }
    }
    async genPlaylistView(start = 0, user, admin = false) {
        const list = (user) ? (admin) ? this.list.getFromAdmin(user) : this.list.getFromOwner(user) : this.list.getAll();
        const array = await list.skip(start).limit(10).toArray();
        const button = new Array();
        array.map((item, index) => {
            if (index < 5) {
                if (!button[0])
                    button[0] = new Array();
                button[0].push({
                    callback_data: `ListInfo ${item._id.toHexString()}`,
                    text: String(start + index + 1)
                });
            }
            else {
                if (!button[1])
                    button[1] = new Array();
                button[1].push({
                    callback_data: `ListInfo ${item._id.toHexString()}`,
                    text: String(start + index + 1)
                });
            }
        });
        if (0 < await list.count()) {
            button.push(new Array());
            if (start - 10 >= 0) {
                button[button.length - 1].push({
                    callback_data: `List ${(user) ? user.toHexString() : undefined} ${start - 10}`,
                    text: "<"
                });
            }
            if (start + 10 < await list.count()) {
                button[button.length - 1].push({
                    callback_data: `List ${(user) ? user.toHexString() : undefined} ${start + 10}`,
                    text: ">"
                });
            }
        }
        if (admin) {
            button.push(new Array());
            button[button.length - 1].push({
                callback_data: `ListSwitch Owned`,
                text: "Mode: Admin"
            });
        }
        else {
            button.push(new Array());
            button[button.length - 1].push({
                callback_data: `ListSwitch Admin`,
                text: "Mode: Owned"
            });
        }
        if (user) {
            button.push(new Array());
            button[button.length - 1].push({
                callback_data: `ListCreate ${user}`,
                text: "Create new playlist"
            });
        }
        return {
            button,
            text: "Playlist:\n" + array.map((item, index) => `${start + index + 1}. ${item.name} (${item.audio.length} sounds)`).join("\n")
        };
    }
    async genListInfoView(listID, user) {
        const list = await this.list.get(listID);
        const button = new Array(new Array(), new Array(), new Array());
        if (!list)
            throw ERR_LIST_NOT_FOUND;
        if (list.owner.equals(user) || list.admin.find(id => id.equals(user)))
            button[0].push({ text: "Add sounds", callback_data: `ListAudioAdd ${listID.toHexString()}` });
        button[0].push({ text: "Show sounds", callback_data: `ListAudio show ${listID.toHexString()}` });
        if (list.owner.equals(user) || list.admin.find(id => id.equals(user)))
            button[0].push({ text: "Delete sounds", callback_data: `ListAudio delete ${listID.toHexString()}` });
        if (list.owner.equals(user))
            button[1].push({ text: "Add Admin", callback_data: `ListAdminAdd ${listID.toHexString()}` });
        if (list.owner.equals(user))
            button[1].push({ text: "Remove Admin", callback_data: `ListAdminRemove ${listID.toHexString()}` });
        if (list.owner.equals(user))
            button[2].push({ text: "Rename", callback_data: `ListRename ${listID.toHexString()}` });
        if (list.owner.equals(user))
            button[2].push({ text: "Delete", callback_data: `ListDelete ${listID.toHexString()}` });
        return {
            button,
            text: `ID: ${list._id.toHexString()}\nName: ${list.name}\nOwner: ${list.owner}\nSounds: ${list.audio.length}\nAdmins: ${list.admin}`
        };
    }
    async genAudioListView(listID, start = 0, deleteMode = false) {
        const list = await this.list.get(listID);
        if (!list)
            return;
        const button = new Array();
        const audio = await Promise.all(list.audio.slice(start, start + 10).map(item => this.audio.get(item)));
        audio.forEach((item, index) => {
            if (!item)
                return;
            if (index < 5) {
                if (!button[0])
                    button[0] = new Array();
                button[0].push({
                    callback_data: (deleteMode) ? `ListAudioDel ${listID} ${item._id}` : `AudioInfo ${item._id}`,
                    text: String(index + start + 1)
                });
            }
            else {
                if (!button[1])
                    button[1] = new Array();
                button[1].push({
                    callback_data: (deleteMode) ? `ListAudioDel ${listID} ${item._id}` : `AudioInfo ${item._id}`,
                    text: String(index + start + 1)
                });
            }
        });
        if (0 < await list.audio.length) {
            button.push(new Array());
            if (start - 10 >= 0) {
                button[button.length - 1].push({
                    callback_data: `ListAudio ${(deleteMode) ? "delete" : "show"} ${listID} ${start - 10}`,
                    text: "<"
                });
            }
            if (start + 10 < list.audio.length) {
                button[button.length - 1].push({
                    callback_data: `ListAudio ${(deleteMode) ? "delete" : "show"} ${listID} ${start + 10}`,
                    text: ">"
                });
            }
        }
        return {
            button: (button.length > 0) ? button : null,
            text: ((deleteMode) ? "Choose sound to delete:\n" : "Sound list:\n") +
                audio.map((item, index) => (item) ? `${start + index + 1}. ${item.title} ${(item.artist) ? `(${item.artist})` : ""}` : item).join("\n")
        };
    }
    async processAudio(msg) {
        if (!msg.from || !msg.audio)
            return;
        const sender = await this.getUser(msg.from.id);
        if (!sender) {
            this.sendError(msg, ERR_NOT_REGISTER);
            return;
        }
        const source = "tg://" + msg.audio.file_id;
        const replyMessage = await this.sendProcessing(msg);
        if (replyMessage instanceof Error)
            throw replyMessage;
        if (msg.audio && msg.audio.title) {
            try {
                const audio = await this.audio.add(sender._id, source, {
                    artist: msg.audio.performer,
                    duration: msg.audio.duration,
                    title: msg.audio.title
                });
                if (audio)
                    this.processDone(replyMessage, audio);
            }
            catch (e) {
                this.sendError(replyMessage, "An error occured when adding song：" + e.message);
            }
        }
        else {
            let audio = await this.audio.search({ source }).next();
            if (!audio) {
                let title;
                try {
                    title = await PromiseUtils_1.retry(() => this.sendNeedTitle(msg), 3);
                }
                catch (error) {
                    return;
                }
                audio = await this.audio.add(sender._id, source, {
                    artist: msg.audio.performer,
                    duration: msg.audio.duration,
                    title
                });
            }
            if (audio)
                this.processDone(replyMessage, audio);
        }
    }
    async processFile(msg) {
        if (!msg.from || !msg.document)
            return;
        const sender = await this.getUser(msg.from.id);
        if (!sender) {
            this.sendError(msg, ERR_NOT_REGISTER);
            return;
        }
        const source = "tg://" + msg.document.file_id;
        const replyMessage = await this.sendProcessing(msg);
        let audio;
        if (replyMessage instanceof Error)
            throw replyMessage;
        try {
            audio = await this.audio.add(sender._id, source);
        }
        catch (error) {
            if (error === AudioManager_1.ERR_MISSING_TITLE) {
                try {
                    const title = await PromiseUtils_1.retry(() => this.sendNeedTitle(msg, msg.document.file_name), 3);
                    audio = await this.audio.add(sender._id, source, { title });
                }
                catch (error) {
                    this.sendError(replyMessage, "Failed to process the file:" + error.message);
                }
            }
            else {
                this.sendError(replyMessage, "Failed to process the file:" + error.message);
            }
        }
        if (audio)
            this.processDone(replyMessage, audio);
    }
    async processLink(msg, link) {
        if (msg.from == null)
            return;
        link = encodeURI(decodeURIComponent(url_1.parse(link).href));
        const sender = await this.getUser(msg.from.id);
        let audio;
        if (!sender) {
            this.sendError(msg, ERR_NOT_REGISTER);
            return;
        }
        try {
            audio = await this.audio.add(sender._id, link);
        }
        catch (error) {
            if (error === AudioManager_1.ERR_MISSING_TITLE) {
                try {
                    const title = await PromiseUtils_1.retry(() => this.sendNeedTitle(msg, path_1.basename(url_1.parse(decodeURI(link)).pathname)), 3);
                    audio = await this.audio.add(sender._id, link, { title });
                }
                catch (error) {
                    this.sendError(msg, `Failed to process the link ${link}: ${error.message}`);
                }
            }
            else {
                this.sendError(msg, `Failed to process the link ${link}: ${error.message}`);
            }
        }
        if (audio)
            this.processDone(msg, audio);
    }
    async sendProcessing(msg) {
        return this.queueSendMessage(msg.chat.id, "Processing...", {
            reply_to_message_id: msg.message_id
        });
    }
    async sendError(msg, errorMessage) {
        if (!msg.from)
            return;
        if (msg.from.id === this.me.id) {
            return this.bot.editMessageText(errorMessage, {
                chat_id: msg.chat.id,
                disable_web_page_preview: true,
                message_id: msg.message_id
            });
        }
        else {
            return this.queueSendMessage(msg.chat.id, errorMessage, {
                disable_web_page_preview: true,
                reply_to_message_id: msg.message_id
            });
        }
    }
    async sendNeedTitle(msg, filename) {
        if (filename)
            filename = filename.replace(/\.\w+$/i, "");
        const needTitle = await this.queueSendMessage(msg.chat.id, "The music doesn't have a title.\nPlease add one for it!", {
            reply_markup: {
                force_reply: true,
                inline_keyboard: (filename) ? [[{ text: "Use filename", callback_data: `setTitle/${msg.message_id}/${filename}` }]] : undefined,
                selective: true,
            },
            reply_to_message_id: msg.message_id
        });
        return new Promise((resolve, reject) => {
            const callbackListener = (query) => {
                if (!query.data || !msg.from || query.from.id !== msg.from.id)
                    return;
                const data = query.data.split("/");
                if (data.length !== 3 || data[0] !== "setTitle" || parseInt(data[1], 10) !== msg.message_id)
                    return;
                resolve(data[2]);
                this.bot.deleteMessage(needTitle.chat.id, String(needTitle.message_id));
                this.bot.removeReplyListener(needTitle.message_id);
                this.bot.removeListener("callback_query", callbackListener);
            };
            this.bot.on("callback_query", callbackListener);
            this.bot.onReplyToMessage(msg.chat.id, needTitle.message_id, reply => {
                if (!reply.from || !msg.from || reply.from.id !== msg.from.id)
                    return;
                if (reply.text) {
                    this.queueSendMessage(reply.chat.id, "Title set", { reply_to_message_id: reply.message_id });
                    resolve(reply.text);
                }
                else {
                    this.queueSendMessage(reply.chat.id, "It doesn't look like a title.", { reply_to_message_id: reply.message_id, });
                    reject(ERR_NOT_VALID_TITLE);
                }
                this.bot.removeReplyListener(needTitle.message_id);
                this.bot.removeListener("callback_query", callbackListener);
            });
        });
    }
    async processDone(msg, audio) {
        const session = this.audioAddSession.get(msg.chat.id);
        if (session)
            this.list.addAudio(session, audio._id);
        const message = `ID: ${audio._id}\nTitle: ${audio.title}${(session) ? "\n\nAdded to list!" : ""}`;
        if (msg.from && msg.from.id === this.me.id) {
            return this.bot.editMessageText(message, {
                chat_id: msg.chat.id,
                message_id: msg.message_id
            });
        }
        else {
            return this.queueSendMessage(msg.chat.id, message, {
                reply_to_message_id: msg.message_id
            });
        }
    }
    getUser(id) {
        return this.user.get(exports.BIND_TYPE, id);
    }
    getFile(fileId) {
        fileId = fileId.replace("tg://", "");
        return this.bot.getFileLink(fileId);
    }
    async getMetadata(fileId) {
        const file = await this.getFile(fileId);
        return this.audio.urlParser.getMetadata(file);
    }
    queueSendMessage(chatId, text, options) {
        return this.messageQueue.add(async () => {
            const callback = this.bot.sendMessage(chatId, text, options);
            await PromiseUtils_1.sleep(1000);
            return callback;
        });
    }
}
exports.Telegram = Telegram;
//# sourceMappingURL=Telegram.js.map