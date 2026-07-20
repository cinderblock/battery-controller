/**
 * App root — provides session context and routes between views.
 *
 * Pages:
 * - / (chart view — main interface)
 * - /health (battery health — rank/compare/cull cells)
 * - /sequences (sequence editor)
 * - /temperature (temperature channel management)
 */

import { useEffect, useState } from 'react';
import { SessionContext, useDeviceSessionManager } from './hooks/useDeviceSession.ts';
import { ChartView } from './views/ChartView.tsx';
import { HealthView } from './views/HealthView.tsx';
import { SequenceEditor } from './views/SequenceEditor.tsx';
import { TemperatureSettings } from './views/TemperatureSettings.tsx';

function Router() {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  if (path === '/health') return <HealthView />;
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
