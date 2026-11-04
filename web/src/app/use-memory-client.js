import { useEffect, useState } from 'react';
import { createMemoryClient } from './memory.js';

/**
 * The memory client a page owns while it is mounted. A client is a closeable resource (it registers itself for
 * sign-out and owns an abort controller for life), so it is created in effect setup and closed by that setup's own
 * cleanup, never during render: React's development StrictMode replays setup → cleanup → setup, and each setup
 * must obtain a fresh, open client while cleanup disposes exactly the instance it created. Until the first setup
 * runs, and whenever there is no connection, the client is null. Sign-out still closes every open client at once
 * through `forgetConnections`; leaving the page closes the one this page owns.
 */
export function useMemoryClient(connection) {
  const [client, setClient] = useState(null);
  useEffect(() => {
    if (!connection) { setClient(null); return undefined; }
    const owned = createMemoryClient(connection);
    setClient(owned);
    return () => {
      owned.close();
      setClient((current) => (current === owned ? null : current));
    };
  }, [connection]);
  return client;
}
