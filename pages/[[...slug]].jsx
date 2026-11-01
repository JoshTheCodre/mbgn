import { useEffect, useState } from 'react';
import Site from '../client/main.jsx';
import { BootScreen } from '../client/ui.jsx';

// The site's pages run in the browser with their own router, on every path.
// The prebuilt page holds the loading screen, so something shows before any script has run.
export default function Page() {
  const [ready, setReady] = useState(false);
  useEffect(() => { setReady(true); }, []);
  return ready ? <Site /> : <BootScreen />;
}
