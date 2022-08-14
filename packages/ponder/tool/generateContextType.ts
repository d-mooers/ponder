import fs from "node:fs";

import { toolConfig } from "./config";
import type { DbSchema } from "./createDbSchema";
import type { PonderConfig } from "./readUserConfig";
import { SourceKind } from "./readUserConfig";

const header = `
/* Autogenerated file. Do not edit manually. */
`;

const generateContextType = async (
  config: PonderConfig,
  dbSchema: DbSchema
) => {
  let generatedFileCount = 0;

  const entityNames = dbSchema.tables.map((table) => table.name);
  const contractNames = config.sources
    .filter((source) => source.kind === SourceKind.EVM)
    .map((source) => source.name);

  const entityQueryBuilderTypes = entityNames
    .map((entityName) => `${entityName}: Knex.QueryBuilder<${entityName}>;`)
    .join("");

  const contractTypes = contractNames
    .map((contractName) => `${contractName}: ${contractName};`)
    .join("");

  const imports = `
  import { Knex } from "knex";
  import type { ${entityNames.join(", ")} } from "./schema";
  import type { ${contractNames.join(", ")} } from "./typechain";
  `;

  const body = `
  export type Context = {
    entities: {
      ${entityQueryBuilderTypes}
    }
    contracts: {
      ${contractTypes}
    }
  }
  `;

  const final = header + imports + body;

  fs.writeFileSync(
    `${toolConfig.pathToGeneratedDir}/context.d.ts`,
    final,
    "utf8"
  );
  generatedFileCount += 1;

  return generatedFileCount;
};

export { generateContextType };
