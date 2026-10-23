import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';
import '@fontsource-variable/inter';
import './styles/tokens.css';
import './styles/app.css';
import { api, setUnauthorizedHandler } from './lib/api.ts';
import { connectEvents, useApp } from './lib/store.ts';
import { Shell } from './components/Shell.tsx';
import { Toasts } from './components/ui.tsx';
import { Login } from './pages/Login.tsx';
import { HomePage } from './pages/Home.tsx';
import { BrandsPage } from './pages/Brands.tsx';
import { BrandDetailPage } from './pages/BrandDetail.tsx';
import { ProjectsPage } from './pages/Projects.tsx';
import { LibraryPage } from './pages/Library.tsx';
import { PlannedPage } from './pages/Planned.tsx';
import { ContentPage } from './pages/Content.tsx';
import { ResultsPage } from './pages/Results.tsx';
import { InboxPage } from './pages/Inbox.tsx';
import { AutomationsPage } from './pages/Automations.tsx';
import { SettingsPage, applyTheme } from './pages/Settings.tsx';
import { EditorPage } from './editor/EditorPage.tsx';

function App() {
  const [auth, setAuth] = useState<{ setupDone: boolean; authenticated: boolean } | null>(null);
  const loadBrands = useApp((s) => s.loadBrands);
  const loc = useLocation();

  useEffect(() => {
    setUnauthorizedHandler(() => setAuth((a) => (a ? { ...a, authenticated: false } : a)));
    api.get('/api/auth/status').then(setAuth, () => setAuth({ setupDone: true, authenticated: false }));
  }, []);

  useEffect(() => {
    if (!auth?.authenticated) return;
    loadBrands().catch(() => {});
    connectEvents();
    api.get('/api/settings/theme').then((t) => t && applyTheme(t)).catch(() => {});
  }, [auth?.authenticated, loadBrands]);

  if (!auth) return null;
  if (!auth.authenticated) return <Login setupDone={auth.setupDone} onDone={() => setAuth({ setupDone: true, authenticated: true })} />;

  // O editor ocupa a tela inteira, fora do layout padrão.
  if (loc.pathname.startsWith('/editor/')) {
    return (
      <Routes>
        <Route path="/editor/:id" element={<EditorPage />} />
      </Routes>
    );
  }

  return (
    <Shell>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/marcas" element={<BrandsPage />} />
        <Route path="/marcas/:id" element={<BrandDetailPage />} />
        <Route path="/projetos" element={<ProjectsPage />} />
        <Route path="/biblioteca" element={<LibraryPage />} />
        <Route path="/conteudo" element={<ContentPage />} />
        <Route path="/caixa-de-entrada" element={<InboxPage />} />
        <Route path="/automacoes" element={<AutomationsPage />} />
        <Route path="/resultados" element={<ResultsPage />} />
        <Route path="/configuracoes" element={<SettingsPage />} />
        <Route path="*" element={<PlannedPage area="404" />} />
      </Routes>
    </Shell>
  );
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
      <Toasts />
    </BrowserRouter>
  </StrictMode>,
);
