/**
 * App root — provides session context and routes between views.
 *
 * Three pages:
 * - / (chart view — main interface)
 * - /sequences (sequence editor)
 * - /temperature (temperature channel management)
 */

import { useState, useEffect } from 'react';
import { SessionContext, useDeviceSessionManager } from './hooks/useDeviceSession.ts';
import { ChartView } from './views/ChartView.tsx';
import { SequenceEditor } from './views/SequenceEditor.tsx';
import { TemperatureSettings } from './views/TemperatureSettings.tsx';

function Router() {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  if (path === '/sequences') return <SequenceEditor />;
  if (path === '/temperature') return <TemperatureSettings />;
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
