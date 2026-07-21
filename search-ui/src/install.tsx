import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import "./index.css";

const SCRIPT_URL = "/feedback.vrchat.com.user.js";

type InstallState =
  | { kind: "unknown" }
  | { kind: "installed"; version: string };

function readInstalledVersion(): string | null {
  const value =
    document.documentElement.getAttribute("data-vrcfs-installed");
  return value && value.length > 0 ? value : null;
}

function useInstalledDetection(): InstallState {
  const [state, setState] = useState<InstallState>(() => {
    const version = readInstalledVersion();
    return version ? { kind: "installed", version } : { kind: "unknown" };
  });

  useEffect(() => {
    if (state.kind === "installed") {
      return;
    }
    // The userscript matches this page and stamps documentElement once it
    // boots. It may not have run yet at first paint, so poll briefly.
    let cancelled = false;
    const started = Date.now();
    const tick = (): void => {
      if (cancelled) {
        return;
      }
      const version = readInstalledVersion();
      if (version) {
        setState({ kind: "installed", version });
        return;
      }
      if (Date.now() - started < 1500) {
        window.setTimeout(tick, 100);
      }
    };
    window.setTimeout(tick, 100);
    return () => {
      cancelled = true;
    };
  }, [state.kind]);

  return state;
}

function StatusBanner({ state }: { state: InstallState }): React.ReactElement {
  if (state.kind === "installed") {
    return (
      <div className="install-status install-status--ok">
        Installed (v{state.version}). Updates are delivered automatically.
      </div>
    );
  }
  return (
    <div className="install-status install-status--idle">
      Not detected yet. Follow the steps below to install.
    </div>
  );
}

function InstallPage(): React.ReactElement {
  const state = useInstalledDetection();
  const installed = state.kind === "installed";

  return (
    <main className="layout install-layout">
      <header className="top">
        <h1>
          <a className="site-title-link" href="/">
            VRChat feedback search
          </a>
        </h1>
        <p className="lede">
          The userscript replaces the search on{" "}
          <a
            href="https://feedback.vrchat.com"
            target="_blank"
            rel="noreferrer"
          >
            feedback.vrchat.com
          </a>{" "}
          with this more advanced search engine. It runs in a userscript manager.
        </p>
      </header>

      <StatusBanner state={state} />

      <section className="install-steps">
        <div className="install-step">
          <h2>1. Install a userscript manager</h2>
          <p>
            If you do not already have one, install Tampermonkey or
            Violentmonkey for your browser:
          </p>
          <ul>
            <li>
              <a
                href="https://www.tampermonkey.net/"
                target="_blank"
                rel="noreferrer"
              >
                Tampermonkey
              </a>{" "}
              (Chrome, Edge, Firefox, Safari)
            </li>
            <li>
              <a
                href="https://violentmonkey.github.io/"
                target="_blank"
                rel="noreferrer"
              >
                Violentmonkey
              </a>{" "}
              (Chrome, Edge, Firefox)
            </li>
          </ul>
        </div>

        <div className="install-step">
          <h2>2. {installed ? "Reinstall or update" : "Install"} the userscript</h2>
          <p>
            Click the button below. Your userscript manager will open its
            install dialog showing the script details, where you can confirm.
          </p>
          <p>
            <a className="install-button" href={SCRIPT_URL}>
              {installed ? "Reinstall userscript" : "Install userscript"}
            </a>
          </p>
          <p className="install-hint">
            Nothing happened? Make sure a userscript manager is enabled, then
            click again. You can also open{" "}
            <a href={SCRIPT_URL}>{SCRIPT_URL}</a> and drag it into your
            manager.
          </p>
        </div>
      </section>

      <p className="lede">
        <a href="/">Back to search</a>
      </p>
    </main>
  );
}

const el = document.getElementById("root");
if (el) {
  ReactDOM.createRoot(el).render(
    <React.StrictMode>
      <InstallPage />
    </React.StrictMode>,
  );
}
