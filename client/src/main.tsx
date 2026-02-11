import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import App from "./App";
import Dashboard from "./pages/Dashboard";
import CrmPipedrive from "./pages/CrmPipedrive";
import DnsSetup from "./pages/DnsSetup";
import GhlLeads from "./pages/GhlLeads";
import GhlConversations from "./pages/GhlConversations";
import AiAgents from "./pages/AiAgents";
import Workflows from "./pages/Workflows";
import WorkflowBuilder from "./pages/WorkflowBuilder";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/crm/pipedrive" element={<CrmPipedrive />} />
        <Route path="/crm/dns" element={<DnsSetup />} />
        <Route path="/leads" element={<GhlLeads />} />
        <Route path="/conversations" element={<GhlConversations />} />
        <Route path="/ai-agents" element={<AiAgents />} />
        <Route path="/workflows" element={<Workflows />} />
        <Route path="/workflows/new" element={<WorkflowBuilder />} />
        <Route path="/workflows/:id" element={<WorkflowBuilder />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
