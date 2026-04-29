import { logger } from "@vendetta";
import { plugin } from "@vendetta";
import { findByStoreName } from "@vendetta/metro";
import { after, instead } from "@vendetta/patcher";
import { showToast } from "@vendetta/ui/toasts";
import Settings from "./Settings";

const LOG_PREFIX = "[impersonation-bot]";
const PATCH_RETRY_INTERVAL_MS = 3000;

type MessageLike = {
    id?: string;
    content?: string;
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

function applyMessageEdit(message: MessageLike | null | undefined) {
    if (!message?.id) return message;

    const editedContent = changes.edits.get(message.id);
    if (!editedContent) return message;
    if (message.__impersonationEdited && message.content === editedContent) return message;

    return cloneWithOverrides(message, {
        content: editedContent,
        editedTimestamp: null,
        isEdited: false,
        __impersonationEdited: true
    });
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

        patchRetryTimer = setInterval(() => {
            ensurePatches();
            loadStoredChanges();
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

        unpatches = [];
        resetState();
        log("Unloaded");
    },

    settings: Settings
};
