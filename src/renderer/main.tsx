import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";

document.documentElement.style.background = "#06101d";
document.documentElement.style.minHeight = "100%";
document.body.style.margin = "0";
document.body.style.minHeight = "100vh";
document.body.style.background = "#06101d";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Missing root element for Rasathane AI.");
}

rootElement.style.minHeight = "100vh";

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
