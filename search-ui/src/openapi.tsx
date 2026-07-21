import React from "react";
import ReactDOM from "react-dom/client";
import { ApiReferenceReact } from "@scalar/api-reference-react";
import "@scalar/api-reference-react/style.css";

const el = document.getElementById("root");
if (el) {
  ReactDOM.createRoot(el).render(
    <React.StrictMode>
      <ApiReferenceReact configuration={{ url: "/openapi.json" }} />
    </React.StrictMode>,
  );
}
