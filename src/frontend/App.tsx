/**
 * App root — provides session context and routes between views.
 *
 * Pages:
 * - / (chart view — main interface)
 * - /health (battery health — rank/compare/cull cells)
 * - /sequences (sequence editor)
 * - /temperature (temperature channel management)
 * - /cell-types (cell types: capacity + voltage limits, and which cell is which type)
 *
 * Every path here must also be in the server's `routes` map (src/server/index.ts)
 * or a refresh on that URL serves "[object Object]".
 */

import { useEffect, useState } from 'react';
import { SessionContext, useDeviceSessionManager } from './hooks/useDeviceSession.ts';
import { CellTypesView } from './views/CellTypesView.tsx';
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
  if (path === '/cell-types') return <CellTypesView />;
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
