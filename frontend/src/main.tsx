import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './pagination.css';
import './portal.css';
import './auth-login.css';
import './features/entry/workspace-entry.css';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
