import { plugin } from "@vendetta";
import { Forms } from "@vendetta/ui/components";
import { showToast } from "@vendetta/ui/toasts";
import { showInputAlert } from "@vendetta/ui/alerts";

const { FormSection, FormRow, FormText } = Forms;

const DEFAULT_API_URL = "http://192.168.0.52:8080/api";

export default function Settings() {
    const apiUrl = typeof plugin.storage.apiUrl === "string" && plugin.storage.apiUrl.length
        ? plugin.storage.apiUrl
        : DEFAULT_API_URL;

    return (
        <FormSection title="Impersonation Bot">
            <FormRow
                label="API URL"
                subLabel={apiUrl}
                onPress={() => {
                    showInputAlert({
                        title: "Set API URL",
                        placeholder: DEFAULT_API_URL,
                        initialValue: apiUrl,
                        confirmText: "Save",
                        onConfirm: (value) => {
                            const nextValue = value?.trim() || DEFAULT_API_URL;
                            plugin.storage.apiUrl = nextValue.replace(/\/+$/, "");
                            showToast("API URL saved");
                        }
                    });
                }}
            />
            <FormText>
                Point this to the API running on your computer. Example: {DEFAULT_API_URL}
            </FormText>
        </FormSection>
    );
}
