import { useEffect, useState } from 'react';
import { MODEL_CATALOG_EVENT } from '@/store/config';

/** Re-render open model selectors when main finishes local/remote discovery. */
export function useModelCatalog(): void {
  const [, setRevision] = useState(0);
  useEffect(() => {
    const refresh = () => setRevision((revision) => revision + 1);
    window.addEventListener(MODEL_CATALOG_EVENT, refresh);
    return () => window.removeEventListener(MODEL_CATALOG_EVENT, refresh);
  }, []);
}
