import { logger } from "@vendetta";
import { plugin } from "@vendetta";
import { registerCommand } from "@vendetta/commands";
import { findByStoreName } from "@vendetta/metro";
import { after, instead } from "@vendetta/patcher";
import { showToast } from "@vendetta/ui/toasts";

const LOG_PREFIX = "[impersonation-bot]";
const DEFAULT_API_URL = "http://192.168.0.52:8080/api";
const PATCH_RETRY_INTERVAL_MS = 3000;
const SYNC_INTERVAL_MS = 4000;
const COMMAND_INPUT_BUILT_IN_TEXT = 1;
const COMMAND_TYPE_CHAT = 1;
const COMMAND_OPTION_TYPE_STRING = 3;

type MessageLike = {
    id?: string;
    content?: string;
    contentParsed?: any;
    editedTimestamp?: any;
    isEdited?: boolean | (() => boolean);
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
let patchRetryTimer: ReturnType<typeof setInterval> | null = null;
let syncTimer: ReturnType<typeof setInterval> | null = null;
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

function getApiUrl() {
    const raw = plugin.storage.apiUrl;
    if (typeof raw === "string" && raw.trim().length) {
        return raw.trim().replace(/\/+$/, "");
    }

    return DEFAULT_API_URL;
}

function setApiUrl(url: string) {
    plugin.storage.apiUrl = url.trim().replace(/\/+$/, "");
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

function resolveCurrentUserId() {
    if (currentUserId) return currentUserId;

    try {
        const UserStore = findByStoreName("UserStore");
        const user = UserStore?.getCurrentUser?.();
        if (user?.id) {
            currentUserId = user.id;
            return currentUserId;
        }
    } catch {
        // Ignore store resolution failures until the next sync pass.
    }

    return null;
}

async function syncChanges() {
    const userId = resolveCurrentUserId();
    if (!userId) return;

    try {
        const response = await fetch(`${getApiUrl()}/changes/${userId}`, {
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
            for (const change of payload.name_changes) {
                if (change?.target_user_id && typeof change?.new_name === "string") {
                    changes.names.set(change.target_user_id, change.new_name);
                }
            }
        }

        log("Synced", `${changes.edits.size} edits`, `${changes.names.size} names`);
    } catch {
        // Keep quiet when the bot API is unreachable.
    }
}

function registerSlashCommands() {
    const baseCommand = {
        applicationId: "-1",
        inputType: COMMAND_INPUT_BUILT_IN_TEXT,
        type: COMMAND_TYPE_CHAT
    };

    unregisterCommands.push(registerCommand({
        ...baseCommand,
        name: "impapi",
        displayName: "impapi",
        description: "Set the API URL for the impersonation bot.",
        displayDescription: "Set the API URL for the impersonation bot.",
        options: [
            {
                name: "url",
                displayName: "url",
                description: "Example: http://192.168.0.52:8080/api",
                displayDescription: "Example: http://192.168.0.52:8080/api",
                required: true,
                type: COMMAND_OPTION_TYPE_STRING
            }
        ],
        execute(args) {
            const options = normalizeCommandArgs(args);
            const url = String(options.url ?? "").trim();

            if (!url) {
                showToast("Usage: /impapi url:<http://ip:port/api>");
                return;
            }

            setApiUrl(url);
            showToast("Impersonation API URL saved");
        }
    }));

    unregisterCommands.push(registerCommand({
        ...baseCommand,
        name: "impsync",
        displayName: "impsync",
        description: "Force a sync from the impersonation bot API.",
        displayDescription: "Force a sync from the impersonation bot API.",
        options: [],
        execute() {
            void syncChanges();
            showToast("Impersonation sync requested");
        }
    }));
}

function applyMessageEdit(message: MessageLike | null | undefined) {
    if (!message?.id) return message;

    const editedContent = changes.edits.get(message.id);
    if (!editedContent) return message;
    if (message.__impersonationEdited && message.content === editedContent) return message;

    const originalEditedTimestamp = message.editedTimestamp;
    const originalIsEdited = message.isEdited;

    const patched = cloneWithOverrides(message, {
        content: editedContent,
        contentParsed: editedContent,
        editedTimestamp: originalEditedTimestamp,
        __impersonationEdited: true
    });

    if (!originalEditedTimestamp) {
        if (typeof originalIsEdited === "function") {
            patched.isEdited = () => false;
        } else {
            patched.isEdited = false;
        }
    }

    return patched;
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

            let changed = false;
            const nextEntries = entries.map((entry) => {
                const patched = applyMessageEdit(entry);
                if (patched !== entry) changed = true;
                return patched;
            });

            if (changed) {
                result._array = nextEntries;
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
    currentUserId = null;
    changes.edits.clear();
    changes.names.clear();
    hasPatchedMessageStore = false;
    hasPatchedUserStore = false;
    hasPatchedGuildMemberStore = false;
}

export default {
    onLoad() {
        ensurePatches();
        registerSlashCommands();
        void syncChanges();

        patchRetryTimer = setInterval(() => {
            ensurePatches();
        }, PATCH_RETRY_INTERVAL_MS);

        syncTimer = setInterval(() => {
            void syncChanges();
        }, SYNC_INTERVAL_MS);

        showToast("Impersonation Bot active");
        log("Loaded with API", getApiUrl());
    },

    onUnload() {
        if (patchRetryTimer) {
            clearInterval(patchRetryTimer);
            patchRetryTimer = null;
        }

        if (syncTimer) {
            clearInterval(syncTimer);
            syncTimer = null;
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
