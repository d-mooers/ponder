import {
  FieldDefinitionNode,
  GraphQLObjectType,
  GraphQLSchema,
  Kind,
} from "graphql";

import { getEntities } from "./helpers";

type DbSchema = {
  tables: DbTable[];
};

type DbTable = {
  name: string;
  columns: DbColumn[];
};

type DbColumn = {
  name: string;
  type: string;
  notNull: boolean;
};

const createDbSchema = (userSchema: GraphQLSchema): DbSchema => {
  const entities = getEntities(userSchema);

  const tables = entities.map(getTableForEntity);

  return { tables: tables };
};

const getTableForEntity = (entity: GraphQLObjectType) => {
  const fields = entity.astNode?.fields || [];
  const columns = fields.map(getColumnForField);

  return {
    name: entity.name,
    columns: columns,
  };
};

const getColumnForField = (field: FieldDefinitionNode) => {
  let notNull = false;
  let type = field.type;

  // If a field is non-nullable, it's TypeNode will be wrapped with another NON_NULL_TYPE TypeNode.
  if (type.kind === Kind.NON_NULL_TYPE) {
    notNull = true;
    type = type.type;
  }

  if (type.kind === Kind.LIST_TYPE) {
    throw new Error(`Unhandled TypeNode: ${Kind.LIST_TYPE}`);
  }

  return {
    name: field.name.value,
    type: type.name.value,
    notNull: notNull,
  };
};

export { createDbSchema };
export type { DbSchema };
