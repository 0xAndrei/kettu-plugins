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

const vendetta = window.vendetta;
const { ReactNative: RN, clipboard } = vendetta.metro.common;
const { Forms, ErrorBoundary } = vendetta.ui.components;
const { showConfirmationAlert, showInputAlert } = vendetta.ui.alerts;
const { getAssetIDByName } = vendetta.ui.assets;
const { useProxy } = vendetta.storage;
const showSimpleActionSheet = find((m) => m?.showSimpleActionSheet && !Object.getOwnPropertyDescriptor(m, "showSimpleActionSheet")?.get);
const actionSheetController = findByProps("openLazy", "hideActionSheet");
const { FormRow, FormSection, FormDivider, FormText } = Forms;

const changes = {
    edits: new Map<string, string>()
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

    for (const [messageId, value] of Object.entries(normalized)) {
        changes.edits.set(messageId, value.content);
    }
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

function saveLocalEdit(messageId: string, content: string, message?: MessageLike | null) {
    const nextEdits = {
        ...getStoredEdits(),
        [messageId]: buildStoredEdit(message, content)
    };

    plugin.storage.messageEdits = nextEdits;
    changes.edits.set(messageId, content);
}

function removeLocalEdit(messageId: string) {
    const nextEdits = { ...getStoredEdits() };
    delete nextEdits[messageId];

    plugin.storage.messageEdits = nextEdits;
    changes.edits.delete(messageId);
}

function clearLocalEdits() {
    plugin.storage.messageEdits = {};
    changes.edits.clear();
}

function openMessageEditor(message: MessageLike | null | undefined) {
    if (!message?.id) {
        showToast("No target message was available");
        return;
    }

    const existing = getStoredEdits()[message.id];

    showInputAlert({
        title: LOCAL_EDIT_LABEL,
        initialValue: existing?.content ?? message.content ?? "",
        placeholder: "Replacement text",
        confirmText: "Save",
        cancelText: "Cancel",
        onConfirm: (input) => {
            if (!input.length) {
                removeLocalEdit(message.id!);
                showToast("Local edit removed");
                return;
            }

            saveLocalEdit(message.id!, input, message);
            showToast("Local edit saved");
        }
    });
}

function openManualMessageEditor(initialIdentifier = "") {
    showInputAlert({
        title: "Message ID or Link",
        initialValue: initialIdentifier,
        placeholder: "1234567890 or discord.com/channels/...",
        confirmText: "Next",
        cancelText: "Cancel",
        onConfirm: (identifier) => {
            const messageId = resolveMessageId(identifier);

            if (!messageId) {
                showToast("Invalid message ID or link");
                return;
            }

            const existing = getStoredEdits()[messageId];
            showInputAlert({
                title: LOCAL_EDIT_LABEL,
                initialValue: existing?.content ?? "",
                placeholder: "Replacement text",
                confirmText: "Save",
                cancelText: "Cancel",
                onConfirm: (content) => {
                    if (!content.length) {
                        removeLocalEdit(messageId);
                        showToast("Local edit removed");
                        return;
                    }

                    saveLocalEdit(messageId, content);
                    showToast("Local edit saved");
                }
            });
        }
    });
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
                onPress: () => openManualMessageEditor(messageId)
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
        execute(args) {
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
    hasPatchedMessageStore = false;
    hasPatchedSimpleActionSheet = false;
    patchedActionSheetNames.clear();
}

function Settings() {
    useProxy(plugin.storage);

    const edits = Object.entries(getStoredEdits())
        .sort(([, left], [, right]) => right.updatedAt - left.updatedAt);

    return (
        <ErrorBoundary>
            <RN.ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 38 }}>
                <FormSection title="Actions" titleStyleType="no_border">
                    <FormRow
                        label="Add or Edit Override"
                        subLabel="Paste a message ID or Discord message link."
                        leading={<FormRow.Icon source={getAssetIDByName("ic_add_24px")} />}
                        trailing={FormRow.Arrow}
                        onPress={() => openManualMessageEditor()}
                    />
                    <FormDivider />
                    <FormRow
                        label="Clear All Local Edits"
                        subLabel={`Currently saved: ${edits.length}`}
                        leading={<FormRow.Icon source={getAssetIDByName("ic_warning_24px")} />}
                        onPress={() => showConfirmationAlert({
                            title: "Clear local edits?",
                            content: "This removes every client-side message override saved by Kettu Tweaks.",
                            confirmText: "Clear",
                            cancelText: "Cancel",
                            onConfirm: () => {
                                clearLocalEdits();
                                showToast("Cleared local edits");
                            }
                        })}
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
            </RN.ScrollView>
        </ErrorBoundary>
    );
}

export default {
    onLoad() {
        hydrateStoredEdits();
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
