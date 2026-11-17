import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// CEL warm-up, the fake HTTP ticks and React renders get slow when the machine is loaded;
// findBy*/waitFor fail on timing alone at the 1000 ms default.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
});
