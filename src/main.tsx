import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createClient } from "@feltdb/feltkit/client";
import { FeltKitProvider } from "@feltdb/feltkit/react";
import "@stack-ui/tokens/tokens.css";
import "@stack-ui/core/core.css";
import "./styles.css";
import { App } from "./App";
import { Site } from "./site/Site";

// Same origin as the page: FeltKit serves the app, its functions, and AppPort together.
const client = createClient();

// The public site (#/site) and the management app are one frontend over the same records.
function Root() {
  return window.location.hash.startsWith("#/site") ? <Site /> : <App />;
}

window.addEventListener("hashchange", () => {
  const site = window.location.hash.startsWith("#/site");
  if (site !== (document.body.dataset.surface === "site")) window.location.reload();
});
document.body.dataset.surface = window.location.hash.startsWith("#/site") ? "site" : "app";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FeltKitProvider client={client}>
      <Root />
    </FeltKitProvider>
  </StrictMode>,
);
