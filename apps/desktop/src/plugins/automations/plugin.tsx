// Buttons (ADR 0072): below a `meta-bind-button` code block's code, the
// button it writes, in Meta Bind's syntax, which runs its actions through
// the app. What a button does reaches the host's command registry and its
// notes, so this is a built-in plugin's work; an exported page shows the
// block's code.
import { buttonLanguage } from "@nether/automations";
import { ButtonView } from "../../ButtonView.tsx";
import type { BuiltinModule } from "../host.ts";

const plugin: BuiltinModule = {
  activate(context) {
    context.host.codeBlocks.view(buttonLanguage, (props) => <ButtonView {...props} />);
  },
};

export default plugin;
