import { logger } from "@vendetta";
import { plugin } from "@vendetta";
import { registerCommand } from "@vendetta/commands";
import { findByStoreName } from "@vendetta/metro";
import { after, instead } from "@vendetta/patcher";
import { showToast } from "@vendetta/ui/toasts";

const LOG_PREFIX = "[impersonation-bot]";
const PATCH_RETRY_INTERVAL_MS = 3000;
const COMMAND_INPUT_BUILT_IN_TEXT = 1;
const COMMAND_TYPE_CHAT = 1;
const COMMAND_OPTION_TYPE_STRING = 3;

type MessageLike = {
    id?: string;
    content?: string;
    contentParsed?: any;
    editedTimestamp?: any;
    isEdited?: boolean;
    [key: string]: any;
};

type UserLike = {
    id?: string;
    username?: string;
    globalName?: string;
    displayName?: string;
    [key: string]: any;
};

type MemberLike = {
    userId?: string;
    nick?: string;
    displayName?: string;
    [key: string]: any;
};

const changes = {
    edits: new Map<string, string>(),
    names: new Map<string, string>()
};

let patchRetryTimer: ReturnType<typeof setInterval> | null = null;
let unregisterCommands: Array<() => void> = [];
let unpatches: Array<() => void> = [];
let hasPatchedMessageStore = false;
let hasPatchedUserStore = false;
let hasPatchedGuildMemberStore = false;

const log = (...args: any[]) => logger.log(LOG_PREFIX, ...args);

function cloneWithOverrides<T extends Record<string, any>>(value: T, overrides: Partial<T>) {
    try {
        const cloned = Object.create(Object.getPrototypeOf(value) ?? Object.prototype);
        Object.assign(cloned, value, overrides);
        return cloned;
    } catch {
        return Object.assign({}, value, overrides);
    }
}

function loadStoredChanges() {
    const messageEdits = plugin.storage.messageEdits;
    const nameChanges = plugin.storage.nameChanges;

    changes.edits.clear();
    changes.names.clear();

    if (messageEdits && typeof messageEdits === "object") {
        for (const [messageId, newContent] of Object.entries(messageEdits)) {
            if (typeof newContent === "string" && newContent.length) {
                changes.edits.set(messageId, newContent);
            }
        }
    }

    if (nameChanges && typeof nameChanges === "object") {
        for (const [userId, newName] of Object.entries(nameChanges)) {
            if (typeof newName === "string" && newName.length) {
                changes.names.set(userId, newName);
            }
        }
    }
}

function ensureStorageMap(key: "messageEdits" | "nameChanges") {
    const current = plugin.storage[key];
    if (!current || typeof current !== "object") {
        plugin.storage[key] = {};
    }

    return plugin.storage[key] as Record<string, string>;
}

function setMessageOverride(messageId: string, content: string) {
    ensureStorageMap("messageEdits")[messageId] = content;
    changes.edits.set(messageId, content);
}

function removeMessageOverride(messageId: string) {
    delete ensureStorageMap("messageEdits")[messageId];
    changes.edits.delete(messageId);
}

function setNameOverride(userId: string, name: string) {
    ensureStorageMap("nameChanges")[userId] = name;
    changes.names.set(userId, name);
}

function removeNameOverride(userId: string) {
    delete ensureStorageMap("nameChanges")[userId];
    changes.names.delete(userId);
}

function clearOverrides() {
    plugin.storage.messageEdits = {};
    plugin.storage.nameChanges = {};
    changes.edits.clear();
    changes.names.clear();
}

function normalizeCommandArgs(args: any[]) {
    const normalized: Record<string, any> = {};

    if (!Array.isArray(args)) return normalized;

    for (const arg of args) {
        if (arg && typeof arg === "object" && "name" in arg) {
            normalized[arg.name] = arg.value;
        }
    }

    return normalized;
}

function registerSlashCommands() {
    const baseCommand = {
        applicationId: "-1",
        inputType: COMMAND_INPUT_BUILT_IN_TEXT,
        type: COMMAND_TYPE_CHAT
    };

    unregisterCommands.push(registerCommand({
        ...baseCommand,
        name: "msgedit",
        displayName: "msgedit",
        description: "Override a message locally by ID.",
        displayDescription: "Override a message locally by ID.",
        options: [
            {
                name: "message_id",
                displayName: "message_id",
                description: "Target message ID",
                displayDescription: "Target message ID",
                required: true,
                type: COMMAND_OPTION_TYPE_STRING
            },
            {
                name: "text",
                displayName: "text",
                description: "Replacement message text",
                displayDescription: "Replacement message text",
                required: true,
                type: COMMAND_OPTION_TYPE_STRING
            }
        ],
        execute(args) {
            const options = normalizeCommandArgs(args);
            const messageId = String(options.message_id ?? "").trim();
            const text = String(options.text ?? "").trim();

            if (!messageId || !text) {
                showToast("Usage: /msgedit message_id:<id> text:<new text>");
                return;
            }

            setMessageOverride(messageId, text);
            showToast("Message override saved");
        }
    }));

    unregisterCommands.push(registerCommand({
        ...baseCommand,
        name: "msgclear",
        displayName: "msgclear",
        description: "Remove a local message override by ID.",
        displayDescription: "Remove a local message override by ID.",
        options: [
            {
                name: "message_id",
                displayName: "message_id",
                description: "Target message ID",
                displayDescription: "Target message ID",
                required: true,
                type: COMMAND_OPTION_TYPE_STRING
            }
        ],
        execute(args) {
            const options = normalizeCommandArgs(args);
            const messageId = String(options.message_id ?? "").trim();

            if (!messageId) {
                showToast("Usage: /msgclear message_id:<id>");
                return;
            }

            removeMessageOverride(messageId);
            showToast("Message override removed");
        }
    }));

    unregisterCommands.push(registerCommand({
        ...baseCommand,
        name: "nameedit",
        displayName: "nameedit",
        description: "Override a displayed username locally by user ID.",
        displayDescription: "Override a displayed username locally by user ID.",
        options: [
            {
                name: "user_id",
                displayName: "user_id",
                description: "Target user ID",
                displayDescription: "Target user ID",
                required: true,
                type: COMMAND_OPTION_TYPE_STRING
            },
            {
                name: "name",
                displayName: "name",
                description: "Replacement display name",
                displayDescription: "Replacement display name",
                required: true,
                type: COMMAND_OPTION_TYPE_STRING
            }
        ],
        execute(args) {
            const options = normalizeCommandArgs(args);
            const userId = String(options.user_id ?? "").trim();
            const name = String(options.name ?? "").trim();

            if (!userId || !name) {
                showToast("Usage: /nameedit user_id:<id> name:<new name>");
                return;
            }

            setNameOverride(userId, name);
            showToast("Name override saved");
        }
    }));

    unregisterCommands.push(registerCommand({
        ...baseCommand,
        name: "nameclear",
        displayName: "nameclear",
        description: "Remove a local name override by user ID.",
        displayDescription: "Remove a local name override by user ID.",
        options: [
            {
                name: "user_id",
                displayName: "user_id",
                description: "Target user ID",
                displayDescription: "Target user ID",
                required: true,
                type: COMMAND_OPTION_TYPE_STRING
            }
        ],
        execute(args) {
            const options = normalizeCommandArgs(args);
            const userId = String(options.user_id ?? "").trim();

            if (!userId) {
                showToast("Usage: /nameclear user_id:<id>");
                return;
            }

            removeNameOverride(userId);
            showToast("Name override removed");
        }
    }));

    unregisterCommands.push(registerCommand({
        ...baseCommand,
        name: "impclear",
        displayName: "impclear",
        description: "Clear all local message and name overrides.",
        displayDescription: "Clear all local message and name overrides.",
        options: [],
        execute() {
            clearOverrides();
            showToast("All overrides cleared");
        }
    }));
}

function applyMessageEdit(message: MessageLike | null | undefined) {
    if (!message?.id) return message;

    const editedContent = changes.edits.get(message.id);
    if (!editedContent) return message;
    if (message.__impersonationEdited && message.content === editedContent) return message;

    try {
        message.content = editedContent;
        message.contentParsed = editedContent;
        message.__impersonationEdited = true;

        try {
            delete message.editedTimestamp;
        } catch {
            message.editedTimestamp = undefined;
        }

        if (typeof message.isEdited === "function") {
            message.isEdited = () => false;
        } else {
            message.isEdited = false;
        }

        return message;
    } catch {
        return cloneWithOverrides(message, {
            content: editedContent,
            contentParsed: editedContent,
            editedTimestamp: undefined,
            isEdited: false,
            __impersonationEdited: true
        });
    }
}

function applyNameOverride(user: UserLike | null | undefined) {
    if (!user?.id) return user;

    const nextName = changes.names.get(user.id);
    if (!nextName) return user;

    return cloneWithOverrides(user, {
        username: nextName,
        globalName: nextName,
        displayName: nextName
    });
}

function applyMemberOverride(member: MemberLike | null | undefined) {
    if (!member?.userId) return member;

    const nextName = changes.names.get(member.userId);
    if (!nextName) return member;

    return cloneWithOverrides(member, {
        nick: nextName,
        displayName: nextName
    });
}

function patchMessageStore() {
    if (hasPatchedMessageStore) return;

    const MessageStore = findByStoreName("MessageStore");
    if (!MessageStore) return;

    if (typeof MessageStore.getMessage === "function") {
        unpatches.push(instead("getMessage", MessageStore, function (args, orig) {
            const message = orig.apply(this, args);
            return applyMessageEdit(message);
        }));
    }

    if (typeof MessageStore.getMessages === "function") {
        unpatches.push(after("getMessages", MessageStore, (_args, result) => {
            const entries = result?._array;
            if (!Array.isArray(entries) || !entries.length) return result;

            for (let index = 0; index < entries.length; index++) {
                const patched = applyMessageEdit(entries[index]);
                if (patched !== entries[index]) {
                    entries[index] = patched;
                }
            }

            return result;
        }));
    }

    hasPatchedMessageStore = true;
    log("Patched MessageStore");
}

function patchUserStore() {
    if (hasPatchedUserStore) return;

    const UserStore = findByStoreName("UserStore");
    if (!UserStore || typeof UserStore.getUser !== "function") return;

    unpatches.push(after("getUser", UserStore, (_args, result) => applyNameOverride(result)));
    hasPatchedUserStore = true;
    log("Patched UserStore");
}

function patchGuildMemberStore() {
    if (hasPatchedGuildMemberStore) return;

    const GuildMemberStore = findByStoreName("GuildMemberStore");
    if (!GuildMemberStore || typeof GuildMemberStore.getMember !== "function") return;

    unpatches.push(after("getMember", GuildMemberStore, (_args, result) => applyMemberOverride(result)));
    hasPatchedGuildMemberStore = true;
    log("Patched GuildMemberStore");
}

function ensurePatches() {
    patchMessageStore();
    patchUserStore();
    patchGuildMemberStore();

    if (hasPatchedMessageStore && hasPatchedUserStore && hasPatchedGuildMemberStore && patchRetryTimer) {
        clearInterval(patchRetryTimer);
        patchRetryTimer = null;
    }
}

function resetState() {
    changes.edits.clear();
    changes.names.clear();
    hasPatchedMessageStore = false;
    hasPatchedUserStore = false;
    hasPatchedGuildMemberStore = false;
}

export default {
    onLoad() {
        loadStoredChanges();
        ensurePatches();
        registerSlashCommands();

        patchRetryTimer = setInterval(() => {
            ensurePatches();
        }, PATCH_RETRY_INTERVAL_MS);

        showToast("Impersonation Bot active");
        log("Loaded", `${changes.edits.size} message overrides`, `${changes.names.size} name overrides`);
    },

    onUnload() {
        if (patchRetryTimer) {
            clearInterval(patchRetryTimer);
            patchRetryTimer = null;
        }

        for (const unpatch of unpatches) {
            try {
                unpatch();
            } catch {
                // Ignore cleanup failures.
            }
        }

        for (const unregister of unregisterCommands) {
            try {
                unregister();
            } catch {
                // Ignore command cleanup failures.
            }
        }

        unregisterCommands = [];
        unpatches = [];
        resetState();
        log("Unloaded");
    }
};
