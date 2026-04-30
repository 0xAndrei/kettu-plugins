import { logger } from "@vendetta";
import { plugin } from "@vendetta";
import { registerCommand } from "@vendetta/commands";
import { find, findByName, findByProps, findByStoreName } from "@vendetta/metro";
import { after, instead } from "@vendetta/patcher";
import { showToast } from "@vendetta/ui/toasts";

const LOG_PREFIX = "[kettu-tweaks]";
const PATCH_RETRY_INTERVAL_MS = 3000;
const COMMAND_INPUT_BUILT_IN_TEXT = 1;
const COMMAND_TYPE_CHAT = 1;
const COMMAND_OPTION_TYPE_STRING = 3;
const COMMAND_OPTION_TYPE_USER = 6;
const LOCAL_EDIT_LABEL = "Edit Local Message";
const ACTION_SHEET_NAMES = [
    "MessageLongPressActionSheet",
    "LongPressMessageActionSheet",
    "MessageContextActionSheet",
    "MessageActionSheet"
];

const MESSAGE_LINK_RE = /discord\.com\/channels\/(?:@me|\d+)\/\d+\/(\d+)/;

type MessageLike = {
    id?: string;
    content?: string;
    contentParsed?: any;
    editedTimestamp?: any;
    isEdited?: boolean | (() => boolean);
    channel_id?: string;
    author?: {
        id?: string;
        username?: string;
        globalName?: string;
    };
    [key: string]: any;
};

type StoredEdit = {
    content: string;
    originalContent?: string;
    authorId?: string;
    authorName?: string;
    channelId?: string;
    updatedAt: number;
};

type StoredEditMap = Record<string, StoredEdit>;

type StoredLocalMessage = {
    id: string;
    channelId: string;
    content: string;
    authorId?: string;
    authorName: string;
    avatarUrl?: string;
    createdAt: number;
};

type StoredLocalMessageMap = Record<string, StoredLocalMessage>;

const vendetta = window.vendetta;
const { ReactNative: RN, clipboard } = vendetta.metro.common;
const { Forms } = vendetta.ui.components;
const { getAssetIDByName } = vendetta.ui.assets;
const { useProxy } = vendetta.storage;
const showSimpleActionSheet = find((m) => m?.showSimpleActionSheet && !Object.getOwnPropertyDescriptor(m, "showSimpleActionSheet")?.get);
const actionSheetController = findByProps("openLazy", "hideActionSheet");
const { FormRow, FormSection, FormDivider, FormText, FormInput } = Forms;

const changes = {
    edits: new Map<string, string>(),
    localMessages: new Map<string, StoredLocalMessage>()
};

let patchRetryTimer: ReturnType<typeof setInterval> | null = null;
let unregisterCommands: Array<() => void> = [];
let unpatches: Array<() => void> = [];
let hasPatchedMessageStore = false;
let hasPatchedSimpleActionSheet = false;
const patchedActionSheetNames = new Set<string>();

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

function isMessageLike(value: any): value is MessageLike {
    return !!value
        && typeof value === "object"
        && typeof value.id === "string"
        && ("content" in value || "author" in value || "channel_id" in value);
}

function findMessageLike(value: any, depth = 0): MessageLike | null {
    if (!value || depth > 4) return null;
    if (isMessageLike(value)) return value;

    if (Array.isArray(value)) {
        for (const entry of value) {
            const found = findMessageLike(entry, depth + 1);
            if (found) return found;
        }

        return null;
    }

    if (typeof value !== "object") return null;

    for (const key of Object.keys(value)) {
        const found = findMessageLike(value[key], depth + 1);
        if (found) return found;
    }

    return null;
}

function normalizeStoredEdit(messageId: string, value: any): StoredEdit | null {
    if (typeof value === "string") {
        return {
            content: value,
            updatedAt: Date.now()
        };
    }

    if (!value || typeof value !== "object" || typeof value.content !== "string") {
        return null;
    }

    return {
        content: value.content,
        originalContent: typeof value.originalContent === "string" ? value.originalContent : undefined,
        authorId: typeof value.authorId === "string" ? value.authorId : undefined,
        authorName: typeof value.authorName === "string" ? value.authorName : undefined,
        channelId: typeof value.channelId === "string" ? value.channelId : undefined,
        updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now()
    };
}

function getStoredEdits() {
    const raw = plugin.storage.messageEdits;

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        plugin.storage.messageEdits = {};
    }

    return plugin.storage.messageEdits as StoredEditMap;
}

function normalizeStoredLocalMessage(value: any): StoredLocalMessage | null {
    if (!value || typeof value !== "object") {
        return null;
    }

    if (
        typeof value.id !== "string"
        || typeof value.channelId !== "string"
        || typeof value.content !== "string"
        || typeof value.authorName !== "string"
    ) {
        return null;
    }

    return {
        id: value.id,
        channelId: value.channelId,
        content: value.content,
        authorId: typeof value.authorId === "string" ? value.authorId : undefined,
        authorName: value.authorName,
        avatarUrl: typeof value.avatarUrl === "string" ? value.avatarUrl : undefined,
        createdAt: typeof value.createdAt === "number" ? value.createdAt : Date.now()
    };
}

function getStoredLocalMessages() {
    const raw = plugin.storage.localMessages;

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        plugin.storage.localMessages = {};
    }

    return plugin.storage.localMessages as StoredLocalMessageMap;
}

function hydrateStoredEdits() {
    const raw = getStoredEdits();
    const normalized: StoredEditMap = {};

    for (const [messageId, value] of Object.entries(raw)) {
        const nextValue = normalizeStoredEdit(messageId, value);
        if (nextValue) {
            normalized[messageId] = nextValue;
        }
    }

    plugin.storage.messageEdits = normalized;
    changes.edits.clear();
    changes.localMessages.clear();

    for (const [messageId, value] of Object.entries(normalized)) {
        changes.edits.set(messageId, value.content);
    }

    const storedLocalMessages = getStoredLocalMessages();
    const normalizedLocalMessages: StoredLocalMessageMap = {};
    for (const [messageId, value] of Object.entries(storedLocalMessages)) {
        const nextValue = normalizeStoredLocalMessage(value);
        if (!nextValue) continue;

        normalizedLocalMessages[messageId] = nextValue;
        changes.localMessages.set(messageId, nextValue);
    }

    plugin.storage.localMessages = normalizedLocalMessages;
}

function resolveMessageId(input: string) {
    const trimmed = input.trim();
    if (!trimmed.length) return null;

    const linkMatch = trimmed.match(MESSAGE_LINK_RE);
    if (linkMatch?.[1]) return linkMatch[1];
    if (/^\d+$/.test(trimmed)) return trimmed;

    return null;
}

function buildStoredEdit(message: MessageLike | null | undefined, content: string): StoredEdit {
    const existing = message?.id ? getStoredEdits()[message.id] : undefined;

    return {
        content,
        originalContent: typeof message?.content === "string" ? message.content : existing?.originalContent,
        authorId: typeof message?.author?.id === "string" ? message.author.id : existing?.authorId,
        authorName: typeof message?.author?.globalName === "string"
            ? message.author.globalName
            : typeof message?.author?.username === "string"
                ? message.author.username
                : existing?.authorName,
        channelId: typeof message?.channel_id === "string" ? message.channel_id : existing?.channelId,
        updatedAt: Date.now()
    };
}

function getStoredLocalMessagesForChannel(channelId: string | null | undefined) {
    if (!channelId) return [];

    return Array.from(changes.localMessages.values())
        .filter((message) => message.channelId === channelId)
        .sort((left, right) => left.createdAt - right.createdAt);
}

function generateLocalMessageId(timestamp = Date.now()) {
    return `${timestamp}${Math.floor(Math.random() * 1_000_000).toString().padStart(6, "0")}`;
}

function getDisplayTimestamp(createdAt: number) {
    const value = new Date(createdAt);
    return Number.isNaN(value.getTime()) ? new Date() : value;
}

function resolveChannelIdFromStoreArgs(args: any[]) {
    const firstArg = args?.[0];
    if (typeof firstArg === "string") return firstArg;
    if (firstArg && typeof firstArg === "object") {
        if (typeof firstArg.channelId === "string") return firstArg.channelId;
        if (typeof firstArg.channel_id === "string") return firstArg.channel_id;
    }

    return null;
}

function resolveMessageIdFromStoreArgs(args: any[]) {
    const secondArg = args?.[1];
    if (typeof secondArg === "string") return secondArg;
    if (secondArg && typeof secondArg === "object") {
        if (typeof secondArg.messageId === "string") return secondArg.messageId;
        if (typeof secondArg.id === "string") return secondArg.id;
    }

    return null;
}

function getUserStore() {
    return findByStoreName("UserStore");
}

function getGuildMemberStore() {
    return findByStoreName("GuildMemberStore");
}

function resolveCachedUser(userId: string | undefined) {
    if (!userId) return null;

    try {
        return getUserStore()?.getUser?.(userId) ?? null;
    } catch {
        return null;
    }
}

function resolveDisplayName(user: any, guildId?: string | null) {
    if (guildId) {
        try {
            const member = getGuildMemberStore()?.getMember?.(guildId, user?.id);
            if (typeof member?.nick === "string" && member.nick.length) {
                return member.nick;
            }

            if (typeof member?.displayName === "string" && member.displayName.length) {
                return member.displayName;
            }
        } catch {
            // Ignore lookup failures and fall back to the user object.
        }
    }

    if (typeof user?.globalName === "string" && user.globalName.length) {
        return user.globalName;
    }

    if (typeof user?.displayName === "string" && user.displayName.length) {
        return user.displayName;
    }

    if (typeof user?.username === "string" && user.username.length) {
        return user.username;
    }

    return null;
}

function resolveAvatarUrl(user: any) {
    if (!user) return undefined;

    const avatarMethods = [
        user.getAvatarURL,
        user.getAvatarURLString,
        user.getAvatarSource
    ];

    for (const method of avatarMethods) {
        if (typeof method !== "function") continue;

        try {
            const value = method.call(user, undefined, true, 160);
            if (typeof value === "string" && value.length) {
                return value;
            }

            if (value && typeof value === "object" && typeof value.uri === "string" && value.uri.length) {
                return value.uri;
            }
        } catch {
            // Keep trying the next avatar method.
        }
    }

    if (typeof user?.avatarURL === "string" && user.avatarURL.length) {
        return user.avatarURL;
    }

    if (typeof user?.avatar === "string" && typeof user?.id === "string") {
        return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=160`;
    }

    return undefined;
}

function buildLocalAuthor(localMessage: StoredLocalMessage) {
    const cachedUser = resolveCachedUser(localMessage.authorId);
    if (cachedUser) {
        const originalGetAvatarURL = typeof cachedUser.getAvatarURL === "function"
            ? cachedUser.getAvatarURL.bind(cachedUser)
            : null;
        const originalGetAvatarSource = typeof cachedUser.getAvatarSource === "function"
            ? cachedUser.getAvatarSource.bind(cachedUser)
            : null;

        return cloneWithOverrides(cachedUser, {
            username: localMessage.authorName,
            globalName: localMessage.authorName,
            displayName: localMessage.authorName,
            getAvatarURL: (...args: any[]) => localMessage.avatarUrl ?? originalGetAvatarURL?.(...args),
            getAvatarSource: (...args: any[]) => {
                if (localMessage.avatarUrl) {
                    return { uri: localMessage.avatarUrl };
                }

                return originalGetAvatarSource?.(...args);
            }
        });
    }

    return {
        id: localMessage.authorId ?? `local-author-${localMessage.id}`,
        username: localMessage.authorName,
        globalName: localMessage.authorName,
        displayName: localMessage.authorName,
        avatarURL: localMessage.avatarUrl,
        getAvatarURL: () => localMessage.avatarUrl,
        getAvatarSource: () => localMessage.avatarUrl ? { uri: localMessage.avatarUrl } : undefined
    };
}

function getLocalMessageTemplate(channelId: string | null | undefined, entries?: any[] | null) {
    const candidates = Array.isArray(entries)
        ? entries
        : findByStoreName("MessageStore")?.getMessages?.(channelId ?? "")?._array;

    if (!Array.isArray(candidates)) {
        return null;
    }

    for (let index = candidates.length - 1; index >= 0; index--) {
        const candidate = candidates[index];
        if (!candidate?.id) continue;
        if (candidate.__kettuLocalSynthetic) continue;
        return candidate as MessageLike;
    }

    return null;
}

function buildLocalMessage(localMessage: StoredLocalMessage, template?: MessageLike | null) {
    const resolvedTemplate = template ?? getLocalMessageTemplate(localMessage.channelId);
    const base = resolvedTemplate ? cloneWithOverrides(resolvedTemplate, {}) : {};

    return cloneWithOverrides(base, {
        id: localMessage.id,
        nonce: localMessage.id,
        channel_id: localMessage.channelId,
        content: localMessage.content,
        contentParsed: localMessage.content,
        timestamp: getDisplayTimestamp(localMessage.createdAt),
        editedTimestamp: null,
        author: buildLocalAuthor(localMessage),
        attachments: [],
        embeds: [],
        reactions: [],
        stickerItems: [],
        stickers: [],
        messageReference: null,
        interaction: null,
        application: null,
        roleSubscriptionData: null,
        activity: null,
        call: null,
        state: "SENT",
        type: 0,
        flags: 0,
        tts: false,
        pinned: false,
        mentionEveryone: false,
        mentionRoles: [],
        isEdited: false,
        __kettuLocalSynthetic: true
    });
}

function saveLocalMessage(localMessage: StoredLocalMessage) {
    const nextMessages = {
        ...getStoredLocalMessages(),
        [localMessage.id]: localMessage
    };

    plugin.storage.localMessages = nextMessages;
    changes.localMessages.set(localMessage.id, localMessage);
}

function clearLocalMessages() {
    const channelIds = new Set(Array.from(changes.localMessages.values()).map((message) => message.channelId));
    plugin.storage.localMessages = {};
    changes.localMessages.clear();

    try {
        const messageStore = findByStoreName("MessageStore");
        for (const channelId of channelIds) {
            injectStoredLocalMessagesIntoArray(channelId, messageStore?.getMessages?.(channelId)?._array);
        }
    } catch (error) {
        log("Failed to clear live local messages", error);
    }
}

function saveLocalEdit(messageId: string, content: string, message?: MessageLike | null) {
    const existing = getStoredEdits()[messageId];
    const nextEdits = {
        ...getStoredEdits(),
        [messageId]: buildStoredEdit(message, content)
    };

    plugin.storage.messageEdits = nextEdits;
    changes.edits.set(messageId, content);
    mutateLiveEditedMessage(
        message?.channel_id ?? existing?.channelId,
        messageId,
        content,
        false
    );
}

function removeLocalEdit(messageId: string) {
    const existing = getStoredEdits()[messageId];
    const nextEdits = { ...getStoredEdits() };
    delete nextEdits[messageId];

    plugin.storage.messageEdits = nextEdits;
    changes.edits.delete(messageId);

    mutateLiveEditedMessage(
        existing?.channelId,
        messageId,
        existing?.originalContent,
        true
    );
}

function clearLocalEdits() {
    plugin.storage.messageEdits = {};
    changes.edits.clear();
}

function ensureDraftState() {
    if (typeof plugin.storage.draftMessage !== "string") {
        plugin.storage.draftMessage = "";
    }

    if (typeof plugin.storage.draftContent !== "string") {
        plugin.storage.draftContent = "";
    }
}

function stageDraft(messageId: string, content = "") {
    ensureDraftState();
    plugin.storage.draftMessage = messageId;
    plugin.storage.draftContent = content;
}

function saveDraftEdit() {
    ensureDraftState();

    const messageId = resolveMessageId(plugin.storage.draftMessage);
    if (!messageId) {
        showToast("Invalid message ID or link");
        return;
    }

    const content = String(plugin.storage.draftContent ?? "");
    if (!content.length) {
        removeLocalEdit(messageId);
        showToast("Local edit removed");
        return;
    }

    saveLocalEdit(messageId, content);
    showToast("Local edit saved");
}

function setLiveEditedFields(message: MessageLike, content: string, clearOverride = false) {
    message.content = content;
    message.contentParsed = content;

    if (clearOverride) {
        delete message.__kettuLocalEditApplied;
    } else {
        message.__kettuLocalEditApplied = true;
    }

    if (!message.editedTimestamp) {
        if (typeof message.isEdited === "function") {
            message.isEdited = () => false;
        } else {
            message.isEdited = false;
        }
    }
}

function mutateLiveEditedMessage(
    channelId: string | undefined,
    messageId: string,
    content: string | undefined,
    clearOverride: boolean
) {
    if (!channelId || typeof content !== "string") return;

    try {
        const messageStore = findByStoreName("MessageStore");
        const directMessage = messageStore?.getMessage?.(channelId, messageId);
        if (directMessage) {
            setLiveEditedFields(directMessage, content, clearOverride);
        }

        const entries = messageStore?.getMessages?.(channelId)?._array;
        if (Array.isArray(entries)) {
            for (const entry of entries) {
                if (entry?.id === messageId) {
                    setLiveEditedFields(entry, content, clearOverride);
                }
            }
        }
    } catch (error) {
        log("Failed to mutate live edited message", error);
    }
}

function openMessageEditor(message: MessageLike | null | undefined) {
    if (!message?.id) {
        showToast("No target message was available");
        return;
    }

    const existing = getStoredEdits()[message.id];
    stageDraft(message.id, existing?.content ?? message.content ?? "");
    showToast("Draft loaded in Kettu Tweaks settings");
}

function openManualMessageEditor(initialIdentifier = "") {
    const messageId = resolveMessageId(initialIdentifier);
    if (messageId) {
        const existing = getStoredEdits()[messageId];
        stageDraft(messageId, existing?.content ?? "");
    } else {
        ensureDraftState();
    }

    showToast("Open Kettu Tweaks settings to edit the draft");
}

function openStoredEditMenu(messageId: string, edit: StoredEdit) {
    if (!showSimpleActionSheet) {
        openManualMessageEditor(messageId);
        return;
    }

    showSimpleActionSheet({
        key: `KettuLocalEdit:${messageId}`,
        header: {
            title: messageId,
            icon: <FormRow.Icon style={{ marginRight: 8 }} source={getAssetIDByName("ic_message_retry")} />,
            onClose: () => actionSheetController?.hideActionSheet?.()
        },
        options: [
            {
                        label: "Edit",
                onPress: () => {
                    openManualMessageEditor(messageId);
                    actionSheetController?.hideActionSheet?.();
                }
            },
            {
                label: "Copy Message ID",
                onPress: () => {
                    clipboard.setString(messageId);
                    showToast("Message ID copied");
                }
            },
            {
                label: "Delete",
                isDestructive: true,
                onPress: () => {
                    removeLocalEdit(messageId);
                    showToast("Local edit removed");
                }
            }
        ]
    });
}

function injectSimpleActionSheetOption(args: any[]) {
    const sheet = args[0];
    const options = sheet?.options;
    if (!Array.isArray(options)) return;

    const message = findMessageLike(sheet);
    if (!message?.id) return;

    if (options.some((option: any) => option?.label === LOCAL_EDIT_LABEL)) {
        return;
    }

    options.push({
        label: LOCAL_EDIT_LABEL,
        onPress: () => openMessageEditor(message)
    });
}

function injectMessageAction(props: any, result: any) {
    const message = findMessageLike(props);
    if (!message?.id) return result;

    const actions = vendetta.utils.findInReactTree(result, (node: any) => Array.isArray(node) && node[0]?.key);
    const ActionsSection = actions?.[0]?.type;
    if (!Array.isArray(actions) || !ActionsSection) return result;

    if (actions.some((entry: any) => entry?.key === "kettu-local-edit-section")) {
        return result;
    }

    actions.unshift(
        <ActionsSection key="kettu-local-edit-section">
            <FormRow
                label={LOCAL_EDIT_LABEL}
                leading={<FormRow.Icon source={getAssetIDByName("ic_message_retry")} />}
                onPress={() => {
                    openMessageEditor(message);
                    actionSheetController?.hideActionSheet?.();
                }}
            />
        </ActionsSection>
    );

    return result;
}

function registerLocalCommands() {
    const baseCommand = {
        applicationId: "-1",
        inputType: COMMAND_INPUT_BUILT_IN_TEXT,
        type: COMMAND_TYPE_CHAT
    };

    unregisterCommands.push(registerCommand({
        ...baseCommand,
        name: "localedit",
        displayName: "localedit",
        description: "Save a client-side message edit in Kettu.",
        displayDescription: "Save a client-side message edit in Kettu.",
        options: [
            {
                name: "message",
                displayName: "message",
                description: "Message ID or Discord message link",
                displayDescription: "Message ID or Discord message link",
                required: true,
                type: COMMAND_OPTION_TYPE_STRING
            },
            {
                name: "content",
                displayName: "content",
                description: "Replacement text",
                displayDescription: "Replacement text",
                required: true,
                type: COMMAND_OPTION_TYPE_STRING
            }
        ],
        execute(args, ctx) {
            const options = Object.fromEntries(
                Array.isArray(args)
                    ? args.filter((arg) => arg && typeof arg === "object" && "name" in arg).map((arg) => [arg.name, arg.value])
                    : []
            );

            const messageId = resolveMessageId(String(options.message ?? ""));
            const content = String(options.content ?? "");

            if (!messageId) {
                showToast("Invalid message ID or link");
                return;
            }

            if (!content.length) {
                removeLocalEdit(messageId);
                showToast("Local edit removed");
                return;
            }

            saveLocalEdit(messageId, content);
            mutateLiveEditedMessage(String(ctx?.channel?.id ?? ""), messageId, content, false);
            showToast("Local edit saved");
        }
    }));

    unregisterCommands.push(registerCommand({
        ...baseCommand,
        name: "clearlocaledits",
        displayName: "clearlocaledits",
        description: "Remove every saved local message edit.",
        displayDescription: "Remove every saved local message edit.",
        options: [],
        execute() {
            clearLocalEdits();
            showToast("Cleared local edits");
        }
    }));

    unregisterCommands.push(registerCommand({
        ...baseCommand,
        name: "sendmessage",
        displayName: "sendmessage",
        description: "Create a local fake message in the current channel.",
        displayDescription: "Create a local fake message in the current channel.",
        options: [
            {
                name: "content",
                displayName: "content",
                description: "Message content",
                displayDescription: "Message content",
                required: true,
                type: COMMAND_OPTION_TYPE_STRING
            },
            {
                name: "user",
                displayName: "user",
                description: "Select a user to impersonate",
                displayDescription: "Select a user to impersonate",
                required: false,
                type: COMMAND_OPTION_TYPE_USER
            },
            {
                name: "user_id",
                displayName: "user_id",
                description: "User ID to impersonate",
                displayDescription: "User ID to impersonate",
                required: false,
                type: COMMAND_OPTION_TYPE_STRING
            }
        ],
        execute(args, ctx) {
            const options = Object.fromEntries(
                Array.isArray(args)
                    ? args.filter((arg) => arg && typeof arg === "object" && "name" in arg).map((arg) => [arg.name, arg.value])
                    : []
            );

            const channelId = String(ctx?.channel?.id ?? "");
            if (!channelId.length) {
                showToast("No target channel was available");
                return;
            }

            const content = String(options.content ?? "");
            if (!content.length) {
                showToast("Message content is required");
                return;
            }

            const selectedUser = options.user;
            const selectedUserId = typeof selectedUser === "string"
                ? selectedUser
                : typeof selectedUser?.id === "string"
                    ? selectedUser.id
                    : String(options.user_id ?? "").trim() || undefined;

            if (!selectedUserId) {
                showToast("Provide a user or user_id");
                return;
            }

            const cachedUser = resolveCachedUser(selectedUserId) ?? (selectedUser && typeof selectedUser === "object" ? selectedUser : null);
            if (!cachedUser) {
                showToast("User is not cached. Share a server or be friends first.");
                return;
            }

            const authorName = resolveDisplayName(cachedUser, ctx?.guild?.id) ?? `User ${selectedUserId}`;
            const avatarUrl = resolveAvatarUrl(cachedUser);
            const messageTemplate = getLocalMessageTemplate(channelId);

            if (!messageTemplate) {
                showToast("Open a channel with loaded messages before sending a local fake message");
                return;
            }

            const localMessage: StoredLocalMessage = {
                id: generateLocalMessageId(),
                channelId,
                content,
                authorId: selectedUserId,
                authorName,
                avatarUrl,
                createdAt: Date.now()
            };

            saveLocalMessage(localMessage);
            injectStoredLocalMessagesIntoArray(
                channelId,
                findByStoreName("MessageStore")?.getMessages?.(channelId)?._array
            );
            showToast(`Sent local message as ${authorName}`);
        }
    }));

    unregisterCommands.push(registerCommand({
        ...baseCommand,
        name: "clearlocalmessages",
        displayName: "clearlocalmessages",
        description: "Remove every locally injected fake message.",
        displayDescription: "Remove every locally injected fake message.",
        options: [],
        execute() {
            clearLocalMessages();
            showToast("Cleared local messages");
        }
    }));
}

function applyMessageEdit(message: MessageLike | null | undefined) {
    if (!message?.id) return message;

    const editedContent = changes.edits.get(message.id);
    if (!editedContent) return message;
    if (message.__kettuLocalEditApplied && message.content === editedContent) return message;

    const originalEditedTimestamp = message.editedTimestamp;
    const originalIsEdited = message.isEdited;

    const patched = cloneWithOverrides(message, {
        content: editedContent,
        contentParsed: editedContent,
        editedTimestamp: originalEditedTimestamp,
        __kettuLocalEditApplied: true
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

function injectStoredLocalMessagesIntoArray(channelId: string | null, entries: any) {
    if (!channelId || !Array.isArray(entries)) return false;

    const localMessages = getStoredLocalMessagesForChannel(channelId);
    const localMessageIds = new Set(localMessages.map((message) => message.id));
    let changed = false;

    for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (!entry?.__kettuLocalSynthetic) continue;
        if (localMessageIds.has(entry.id)) continue;

        entries.splice(index, 1);
        changed = true;
    }

    if (!localMessages.length) return changed;

    const messageTemplate = getLocalMessageTemplate(channelId, entries);
    if (!messageTemplate) {
        return changed;
    }

    const existingIds = new Set(entries.map((entry) => entry?.id).filter(Boolean));
    let template: MessageLike | null = messageTemplate;

    for (const localMessage of localMessages) {
        if (existingIds.has(localMessage.id)) continue;

        const rendered = buildLocalMessage(localMessage, template);
        entries.push(rendered);
        existingIds.add(localMessage.id);
        template = rendered;
        changed = true;
    }

    return changed;
}

function patchMessageStore() {
    if (hasPatchedMessageStore) return;

    const MessageStore = findByStoreName("MessageStore");
    if (!MessageStore) return;

    if (typeof MessageStore.getMessage === "function") {
        unpatches.push(instead("getMessage", MessageStore, function (args, orig) {
            const message = orig.apply(this, args);
            if (message) {
                return applyMessageEdit(message);
            }

            const channelId = resolveChannelIdFromStoreArgs(args);
            const messageId = resolveMessageIdFromStoreArgs(args);
            if (!channelId || !messageId) {
                return message;
            }

            const localMessage = changes.localMessages.get(messageId);
            if (!localMessage || localMessage.channelId !== channelId) {
                return message;
            }

            const template = getLocalMessageTemplate(channelId);
            if (!template) {
                return message;
            }

            return buildLocalMessage(localMessage, template);
        }));
    }

    if (typeof MessageStore.getMessages === "function") {
        unpatches.push(after("getMessages", MessageStore, (args, result) => {
            const entries = result?._array;
            if (!Array.isArray(entries)) return result;

            let changed = false;
            const nextEntries = entries.map((entry) => {
                const patched = applyMessageEdit(entry);
                if (patched !== entry) changed = true;
                return patched;
            });

            const channelId = resolveChannelIdFromStoreArgs(args);
            if (injectStoredLocalMessagesIntoArray(channelId, nextEntries)) {
                changed = true;
            }

            if (changed) {
                result._array = nextEntries;
            }

            return result;
        }));
    }

    hasPatchedMessageStore = true;
    log("Patched MessageStore");
}

function patchSimpleActionSheet() {
    if (hasPatchedSimpleActionSheet || !showSimpleActionSheet) return;

    unpatches.push(after("showSimpleActionSheet", showSimpleActionSheet, (args) => {
        try {
            injectSimpleActionSheetOption(args);
        } catch (error) {
            log("Failed to inject simple action sheet option", error);
        }
    }));

    hasPatchedSimpleActionSheet = true;
    log("Patched showSimpleActionSheet");
}

function patchMessageActionSheets() {
    for (const name of ACTION_SHEET_NAMES) {
        if (patchedActionSheetNames.has(name)) continue;

        const sheetModule = findByName(name, false);
        if (!sheetModule?.default) continue;

        unpatches.push(after("default", sheetModule, ([props], result) => {
            try {
                return injectMessageAction(props, result);
            } catch (error) {
                log(`Failed to inject ${name}`, error);
                return result;
            }
        }));

        patchedActionSheetNames.add(name);
        log(`Patched ${name}`);
    }
}

function ensurePatches() {
    patchMessageStore();
    patchSimpleActionSheet();
    patchMessageActionSheets();

    if (hasPatchedMessageStore && (hasPatchedSimpleActionSheet || patchedActionSheetNames.size > 0) && patchRetryTimer) {
        clearInterval(patchRetryTimer);
        patchRetryTimer = null;
    }
}

function resetState() {
    changes.edits.clear();
    changes.localMessages.clear();
    hasPatchedMessageStore = false;
    hasPatchedSimpleActionSheet = false;
    patchedActionSheetNames.clear();
}

function Settings() {
    useProxy(plugin.storage);
    ensureDraftState();

    const edits = Object.entries(getStoredEdits())
        .sort(([, left], [, right]) => right.updatedAt - left.updatedAt);
    const localMessages = Array.from(changes.localMessages.values())
        .sort((left, right) => right.createdAt - left.createdAt);

    return (
        <RN.ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 38 }}>
            <FormSection title="Editor" titleStyleType="no_border">
                <FormInput
                    value={plugin.storage.draftMessage}
                    onChange={(value: string) => plugin.storage.draftMessage = value}
                    placeholder="1234567890 or discord.com/channels/..."
                    title="MESSAGE ID OR LINK"
                />
                <FormDivider />
                <FormInput
                    value={plugin.storage.draftContent}
                    onChange={(value: string) => plugin.storage.draftContent = value}
                    placeholder="Replacement text"
                    title="LOCAL CONTENT"
                />
                <FormDivider />
                <FormRow
                    label="Save Draft as Local Edit"
                    leading={<FormRow.Icon source={getAssetIDByName("Check")} />}
                    onPress={saveDraftEdit}
                />
                <FormDivider />
                <FormRow
                    label="Load From Clipboard"
                    subLabel="Paste a message ID or Discord message link into the draft field."
                    leading={<FormRow.Icon source={getAssetIDByName("copy")} />}
                    onPress={() => clipboard.getString().then((value) => {
                        plugin.storage.draftMessage = value ?? "";
                        showToast("Loaded clipboard into draft");
                    })}
                />
                <FormDivider />
                <FormRow
                    label="Clear All Local Edits"
                    subLabel={`Currently saved: ${edits.length}`}
                    leading={<FormRow.Icon source={getAssetIDByName("ic_warning_24px")} />}
                    onPress={() => {
                        clearLocalEdits();
                        showToast("Cleared local edits");
                    }}
                />
                <FormDivider />
                <FormRow
                    label="Clear All Local Messages"
                    subLabel={`Currently saved: ${localMessages.length}`}
                    leading={<FormRow.Icon source={getAssetIDByName("ic_message_retry")} />}
                    onPress={() => {
                        clearLocalMessages();
                        showToast("Cleared local messages");
                    }}
                />
            </FormSection>
            <FormSection title="Saved Edits">
                {edits.length === 0 && <FormText>No local edits saved yet.</FormText>}
                {edits.map(([messageId, edit], index) => (
                    <React.Fragment key={messageId}>
                        {!!index && <FormDivider />}
                        <FormRow
                            label={edit.authorName || messageId}
                            subLabel={edit.content}
                            trailing={FormRow.Arrow}
                            onPress={() => openStoredEditMenu(messageId, edit)}
                        />
                    </React.Fragment>
                ))}
            </FormSection>
            <FormSection title="Local Messages">
                {localMessages.length === 0 && <FormText>No local messages saved yet.</FormText>}
                {localMessages.map((message, index) => (
                    <React.Fragment key={message.id}>
                        {!!index && <FormDivider />}
                        <FormRow
                            label={message.authorName}
                            subLabel={message.content}
                            trailing={FormRow.Arrow}
                            onPress={() => {
                                clipboard.setString(message.id);
                                showToast("Local message ID copied");
                            }}
                        />
                    </React.Fragment>
                ))}
            </FormSection>
        </RN.ScrollView>
    );
}

export default {
    onLoad() {
        hydrateStoredEdits();
        ensureDraftState();
        ensurePatches();
        registerLocalCommands();

        patchRetryTimer = setInterval(() => {
            ensurePatches();
        }, PATCH_RETRY_INTERVAL_MS);

        showToast("Kettu Tweaks active");
        log("Loaded", `${changes.edits.size} local edits`);
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
    },

    settings: Settings
};
