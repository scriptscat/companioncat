import { definePage } from "../../shell";
import { EnginesPage } from "./EnginesPage";

export { createConfirmHost, type PackVersions } from "./confirm";

export default definePage({ id: "engines", group: "companion", component: ({ narrow, target }) => <EnginesPage narrow={narrow} target={target} /> });
