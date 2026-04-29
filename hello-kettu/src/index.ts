import { logger } from "@vendetta";
import Settings from "./Settings";

export default {
  onLoad: () => {
    logger.log("Hello Kettu loaded");
  },
  onUnload: () => {
    logger.log("Hello Kettu unloaded");
  },
  settings: Settings,
};
