import { plugin } from "@vendetta";
import { Forms } from "@vendetta/ui/components";
import { showInputAlert, showConfirmationAlert } from "@vendetta/ui/alerts";
import { showToast } from "@vendetta/ui/toasts";

const { FormSection, FormRow, FormText } = Forms;

type OverrideMap = Record<string, string>;

function ensureMap(key: "messageEdits" | "nameChanges") {
    const current = plugin.storage[key];
    if (!current || typeof current !== "object") plugin.storage[key] = {};
    return plugin.storage[key] as OverrideMap;
}

function countEntries(key: "messageEdits" | "nameChanges") {
    return Object.keys(ensureMap(key)).length;
}

function parsePair(input: string | undefined, label: string) {
    const raw = input?.trim();
    if (!raw) return null;

    const separatorIndex = raw.indexOf("|");
    if (separatorIndex === -1) {
        showToast(`${label} format: id|value`);
        return null;
    }

    const id = raw.slice(0, separatorIndex).trim();
    const value = raw.slice(separatorIndex + 1).trim();

    if (!id || !value) {
        showToast(`${label} format: id|value`);
        return null;
    }

    return { id, value };
}

export default function Settings() {
    const messageCount = countEntries("messageEdits");
    const nameCount = countEntries("nameChanges");

    return (
        <FormSection title="Impersonation Bot">
            <FormRow
                label="Add message override"
                subLabel={`${messageCount} saved`}
                onPress={() => {
                    showInputAlert({
                        title: "Message override",
                        placeholder: "message_id|new text",
                        confirmText: "Save",
                        onConfirm: (input) => {
                            const parsed = parsePair(input, "Message override");
                            if (!parsed) return;

                            ensureMap("messageEdits")[parsed.id] = parsed.value;
                            showToast("Message override saved");
                        }
                    });
                }}
            />
            <FormRow
                label="Remove message override"
                onPress={() => {
                    showInputAlert({
                        title: "Remove message override",
                        placeholder: "message_id",
                        confirmText: "Remove",
                        onConfirm: (input) => {
                            const id = input?.trim();
                            if (!id) return;

                            delete ensureMap("messageEdits")[id];
                            showToast("Message override removed");
                        }
                    });
                }}
            />
            <FormRow
                label="Add name override"
                subLabel={`${nameCount} saved`}
                onPress={() => {
                    showInputAlert({
                        title: "Name override",
                        placeholder: "user_id|new name",
                        confirmText: "Save",
                        onConfirm: (input) => {
                            const parsed = parsePair(input, "Name override");
                            if (!parsed) return;

                            ensureMap("nameChanges")[parsed.id] = parsed.value;
                            showToast("Name override saved");
                        }
                    });
                }}
            />
            <FormRow
                label="Remove name override"
                onPress={() => {
                    showInputAlert({
                        title: "Remove name override",
                        placeholder: "user_id",
                        confirmText: "Remove",
                        onConfirm: (input) => {
                            const id = input?.trim();
                            if (!id) return;

                            delete ensureMap("nameChanges")[id];
                            showToast("Name override removed");
                        }
                    });
                }}
            />
            <FormRow
                label="Clear all overrides"
                onPress={() => {
                    showConfirmationAlert({
                        title: "Clear all overrides",
                        content: "This removes every saved message and name override on this device.",
                        confirmText: "Clear",
                        onConfirm: () => {
                            plugin.storage.messageEdits = {};
                            plugin.storage.nameChanges = {};
                            showToast("All overrides cleared");
                        }
                    });
                }}
            />
            <FormText>
                This plugin is local only. Use Discord developer mode to copy a message ID or user ID, then enter it as
                `id|replacement`.
            </FormText>
            <FormText>
                Message overrides apply to any visible message, not just your own. Edited markers are hidden for locally
                overridden messages.
            </FormText>
        </FormSection>
    );
}
