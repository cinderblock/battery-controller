/**
 * App root — provides session context and routes between views.
 *
 * Two pages:
 * - / (chart view — main interface)
 * - /sequences (sequence editor)
 */

import { useState, useEffect } from 'react';
import { SessionContext, useDeviceSessionManager } from './hooks/useDeviceSession.ts';
import { ChartView } from './views/ChartView.tsx';
import { SequenceEditor } from './views/SequenceEditor.tsx';

function Router() {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  if (path === '/sequences') return <SequenceEditor />;
  return <ChartView />;
}

export default function App() {
  const session = useDeviceSessionManager();

  return (
    <SessionContext.Provider value={session}>
      <Router />
    </SessionContext.Provider>
  );
}
