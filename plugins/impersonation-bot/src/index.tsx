import { plugin } from "@vendetta";
import { logger } from "@vendetta";
import { findByStoreName } from "@vendetta/metro";
import { after, instead } from "@vendetta/patcher";
import { showToast } from "@vendetta/ui/toasts";
import Settings from "./Settings";

const LOG_PREFIX = "[impersonation-bot]";
const DEFAULT_API_URL = "http://192.168.0.52:8080/api";
const SYNC_INTERVAL_MS = 4000;
const PATCH_RETRY_INTERVAL_MS = 3000;

type MessageLike = {
    id?: string;
    content?: string;
    editedTimestamp?: number;
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

let currentUserId: string | null = null;
let syncTimer: ReturnType<typeof setInterval> | null = null;
let patchRetryTimer: ReturnType<typeof setInterval> | null = null;
let unpatches: Array<() => void> = [];
let hasPatchedMessageStore = false;
let hasPatchedUserStore = false;
let hasPatchedGuildMemberStore = false;

const log = (...args: any[]) => logger.log(LOG_PREFIX, ...args);

function getApiBase() {
    const raw = plugin.storage.apiUrl;
    if (typeof raw === "string" && raw.trim().length) return raw.trim().replace(/\/+$/, "");
    return DEFAULT_API_URL;
}

function getCurrentUserId() {
    if (currentUserId) return currentUserId;

    try {
        const UserStore = findByStoreName("UserStore");
        const user = UserStore?.getCurrentUser?.();
        if (user?.id) {
            currentUserId = user.id;
            log("Resolved current user", currentUserId);
            return currentUserId;
        }
    } catch (error) {
        log("Failed to resolve current user", String(error));
    }

    return null;
}

function cloneWithEdit(message: MessageLike, editedContent: string) {
    try {
        const cloned = Object.create(Object.getPrototypeOf(message) ?? Object.prototype);
        Object.assign(cloned, message, {
            content: editedContent,
            editedTimestamp: Date.now(),
            __impersonationEdited: true
        });
        return cloned;
    } catch {
        return {
            ...message,
            content: editedContent,
            editedTimestamp: Date.now(),
            __impersonationEdited: true
        };
    }
}

function applyMessageEdit(message: MessageLike | null | undefined) {
    if (!message?.id) return message;

    const editedContent = changes.edits.get(message.id);
    if (!editedContent) return message;
    if (message.__impersonationEdited && message.content === editedContent) return message;

    return cloneWithEdit(message, editedContent);
}

function applyNameOverride(user: UserLike | null | undefined) {
    if (!user?.id) return user;

    const nextName = changes.names.get(user.id);
    if (!nextName) return user;

    return {
        ...user,
        username: nextName,
        globalName: nextName,
        displayName: nextName
    };
}

function applyMemberOverride(member: MemberLike | null | undefined) {
    if (!member?.userId) return member;

    const nextName = changes.names.get(member.userId);
    if (!nextName) return member;

    return {
        ...member,
        nick: nextName,
        displayName: nextName
    };
}

async function syncChanges() {
    const userId = getCurrentUserId();
    if (!userId) return;

    try {
        const response = await fetch(`${getApiBase()}/changes/${userId}`, {
            method: "GET",
            headers: {
                Accept: "application/json"
            }
        });

        if (!response.ok) return;

        const payload = await response.json();

        changes.edits.clear();
        changes.names.clear();

        if (Array.isArray(payload?.message_edits)) {
            for (const edit of payload.message_edits) {
                if (edit?.message_id && typeof edit?.new_content === "string") {
                    changes.edits.set(edit.message_id, edit.new_content);
                }
            }
        }

        if (Array.isArray(payload?.name_changes)) {
            for (const nameChange of payload.name_changes) {
                if (nameChange?.target_user_id && typeof nameChange?.new_name === "string") {
                    changes.names.set(nameChange.target_user_id, nameChange.new_name);
                }
            }
        }

        log("Synced", `${changes.edits.size} edits`, `${changes.names.size} names`);
    } catch {
        // API downtime is expected on mobile networks; keep this silent.
    }
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

            const nextEntries = entries.map((message: MessageLike) => applyMessageEdit(message));
            if (nextEntries.every((message: MessageLike, index: number) => message === entries[index])) {
                return result;
            }

            return {
                ...result,
                _array: nextEntries
            };
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
    currentUserId = null;
    changes.edits.clear();
    changes.names.clear();
    hasPatchedMessageStore = false;
    hasPatchedUserStore = false;
    hasPatchedGuildMemberStore = false;
}

export default {
    onLoad() {
        log("Loading with API", getApiBase());

        ensurePatches();
        void syncChanges();

        syncTimer = setInterval(() => {
            void syncChanges();
        }, SYNC_INTERVAL_MS);

        patchRetryTimer = setInterval(() => {
            ensurePatches();
        }, PATCH_RETRY_INTERVAL_MS);

        showToast("Impersonation Bot active");
    },

    onUnload() {
        if (syncTimer) {
            clearInterval(syncTimer);
            syncTimer = null;
        }

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
