import { definePage } from "../../shell";
import { GeneralPage } from "./GeneralPage";

export default definePage({ id: "general", group: "companion", component: () => <GeneralPage /> });
