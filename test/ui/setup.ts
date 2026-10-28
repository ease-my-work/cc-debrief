// Testing Library cleanup after each UI test (vitest runs without globals), and a 5 s wait for findBy* / waitFor:
// the first render in a file (imports, fetch mocks, effects) took over the 1 s default under a full parallel run.
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

configure({ asyncUtilTimeout: 5000 });

afterEach(() => cleanup());
