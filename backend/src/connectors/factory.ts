/**
 * Owned by Task 2-d. Port of backend/onyx/connectors/factory.py +
 * /home/z/onyx/backend/onyx/connectors/registry.py.
 *
 * Python sources:
 *   - /home/z/onyx/backend/onyx/connectors/factory.py
 *     (build_connector / build_project_cc_pair_connector: map the connector's
 *      `source` (DocumentSource) to its class via CONNECTOR_CLASS_MAP, pass
 *      connector_specific_config + credentials, raise for unknown sources)
 *   - /home/z/onyx/backend/onyx/connectors/registry.py
 *     (CONNECTOR_CLASS_MAP: DocumentSource.WEB -> onyx.connectors.web.connector
 *      .WebConnector, DocumentSource.FILE -> onyx.connectors.file.connector
 *      .LocalFileConnector; every other source lives in the connectors/ tree)
 *
 * Port scope: only 'file' and 'web' are implemented. Any other source throws
 * UnsupportedFeatureError — mirroring the "not_implemented" source type used
 * by Standard for connectors that exist in Python but are not enabled here.
 * The registry lives here (not in framework.ts) to avoid an import cycle:
 * framework.ts must stay dependency-light because implementations import it.
 */
import type { ConnectorFactory } from "./framework";
import { UnsupportedFeatureError } from "../utils/errors";
import { FileConnectorRunner } from "./implementations/file";
import { WebConnectorRunner } from "./implementations/web";

/**
 * Port of registry.CONNECTOR_CLASS_MAP restricted to ported sources.
 * Keys mirror the DocumentSource values (configs/constants.ts VALID_SOURCE_TYPES).
 */
export const CONNECTOR_FACTORIES: Record<string, ConnectorFactory> = {
  file: (connectorId, specificConfig, credentials) =>
    new FileConnectorRunner(connectorId, specificConfig, credentials),
  web: (connectorId, specificConfig, credentials) =>
    new WebConnectorRunner(connectorId, specificConfig, credentials),
};

/**
 * Port of factory.build_connector: resolve a ConnectorRunner for a source
 * type, or throw UnsupportedFeatureError for sources that have no ported
 * connector implementation.
 */
export function buildConnectorRunner(
  connectorId: number,
  source: string,
  specificConfig: Record<string, unknown>,
  credentials: Record<string, unknown>,
): ReturnType<ConnectorFactory> {
  const factory = CONNECTOR_FACTORIES[source];
  if (!factory) {
    throw new UnsupportedFeatureError(
      `Connector source '${source}' is not ported to onyx-ts (available: ${Object.keys(CONNECTOR_FACTORIES).join(", ")})`,
    );
  }
  return factory(connectorId, specificConfig, credentials);
}
