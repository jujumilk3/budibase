import cloneDeep from "lodash/cloneDeep"
import validateJs from "validate.js"
import {
  Datasource,
  DatasourcePlusQueryResponse,
  FieldType,
  QueryJson,
  Row,
  SourceName,
  Table,
  TableSchema,
} from "@budibase/types"
import { makeExternalQuery } from "../../../integrations/base/query"
import { Format } from "../../../api/controllers/view/exporters"
import sdk from "../.."
import { isRelationshipColumn } from "../../../db/utils"
import { SqlClient } from "../../../integrations/utils"

const SQL_CLIENT_SOURCE_MAP: Record<SourceName, SqlClient | undefined> = {
  [SourceName.POSTGRES]: SqlClient.POSTGRES,
  [SourceName.MYSQL]: SqlClient.MY_SQL,
  [SourceName.SQL_SERVER]: SqlClient.MS_SQL,
  [SourceName.ORACLE]: SqlClient.ORACLE,
  [SourceName.DYNAMODB]: undefined,
  [SourceName.MONGODB]: undefined,
  [SourceName.ELASTICSEARCH]: undefined,
  [SourceName.COUCHDB]: undefined,
  [SourceName.S3]: undefined,
  [SourceName.AIRTABLE]: undefined,
  [SourceName.ARANGODB]: undefined,
  [SourceName.REST]: undefined,
  [SourceName.FIRESTORE]: undefined,
  [SourceName.GOOGLE_SHEETS]: undefined,
  [SourceName.REDIS]: undefined,
  [SourceName.SNOWFLAKE]: undefined,
  [SourceName.BUDIBASE]: undefined,
}

export function getSQLClient(datasource: Datasource): SqlClient {
  if (!datasource.isSQL) {
    throw new Error("Cannot get SQL Client for non-SQL datasource")
  }
  const lookup = SQL_CLIENT_SOURCE_MAP[datasource.source]
  if (lookup) {
    return lookup
  }
  throw new Error("Unable to determine client for SQL datasource")
}

export async function getDatasourceAndQuery(
  json: QueryJson
): DatasourcePlusQueryResponse {
  const datasourceId = json.endpoint.datasourceId
  const datasource = await sdk.datasources.get(datasourceId)
  return makeExternalQuery(datasource, json)
}

export function cleanExportRows(
  rows: any[],
  schema: TableSchema,
  format: string,
  columns?: string[],
  customHeaders: { [key: string]: string } = {}
) {
  let cleanRows = [...rows]

  const relationships = Object.entries(schema)
    .filter((entry: any[]) => entry[1].type === FieldType.LINK)
    .map(entry => entry[0])

  relationships.forEach(column => {
    cleanRows.forEach(row => {
      delete row[column]
    })
    delete schema[column]
  })

  if (format === Format.CSV) {
    // Intended to append empty values in export
    const schemaKeys = Object.keys(schema)
    for (let key of schemaKeys) {
      if (columns?.length && columns.indexOf(key) > 0) {
        continue
      }
      for (let row of cleanRows) {
        if (row[key] == null) {
          row[key] = undefined
        }
      }
    }
  } else if (format === Format.JSON) {
    // Replace row keys with custom headers
    for (let row of cleanRows) {
      renameKeys(customHeaders, row)
    }
  }

  return cleanRows
}

function renameKeys(keysMap: { [key: string]: any }, row: any) {
  for (const key in keysMap) {
    Object.defineProperty(
      row,
      keysMap[key],
      Object.getOwnPropertyDescriptor(row, key) || {}
    )
    delete row[key]
  }
}

function isForeignKey(key: string, table: Table) {
  const relationships = Object.values(table.schema).filter(isRelationshipColumn)
  return relationships.some(
    relationship => (relationship as any).foreignKey === key
  )
}

export async function validate({
  tableId,
  row,
  table,
}: {
  tableId?: string
  row: Row
  table?: Table
}): Promise<{
  valid: boolean
  errors: Record<string, any>
}> {
  let fetchedTable: Table | undefined
  if (!table && tableId) {
    fetchedTable = await sdk.tables.getTable(tableId)
  } else if (table) {
    fetchedTable = table
  }
  if (fetchedTable === undefined) {
    throw new Error("Unable to fetch table for validation")
  }
  const errors: Record<string, any> = {}
  for (let fieldName of Object.keys(fetchedTable.schema)) {
    const column = fetchedTable.schema[fieldName]
    const constraints = cloneDeep(column.constraints)
    const type = column.type
    // foreign keys are likely to be enriched
    if (isForeignKey(fieldName, fetchedTable)) {
      continue
    }
    // formulas shouldn't validated, data will be deleted anyway
    if (type === FieldType.FORMULA || column.autocolumn) {
      continue
    }
    // special case for options, need to always allow unselected (empty)
    if (type === FieldType.OPTIONS && constraints?.inclusion) {
      constraints.inclusion.push(null as any, "")
    }
    let res

    // Validate.js doesn't seem to handle array
    if (type === FieldType.ARRAY && row[fieldName]) {
      if (row[fieldName].length) {
        if (!Array.isArray(row[fieldName])) {
          row[fieldName] = row[fieldName].split(",")
        }
        row[fieldName].map((val: any) => {
          if (
            !constraints?.inclusion?.includes(val) &&
            constraints?.inclusion?.length !== 0
          ) {
            errors[fieldName] = "Field not in list"
          }
        })
      } else if (constraints?.presence && row[fieldName].length === 0) {
        // non required MultiSelect creates an empty array, which should not throw errors
        errors[fieldName] = [`${fieldName} is required`]
      }
    } else if (
      (type === FieldType.ATTACHMENT || type === FieldType.JSON) &&
      typeof row[fieldName] === "string"
    ) {
      // this should only happen if there is an error
      try {
        const json = JSON.parse(row[fieldName])
        if (type === FieldType.ATTACHMENT) {
          if (Array.isArray(json)) {
            row[fieldName] = json
          } else {
            errors[fieldName] = [`Must be an array`]
          }
        }
      } catch (err) {
        errors[fieldName] = [`Contains invalid JSON`]
      }
    } else {
      res = validateJs.single(row[fieldName], constraints)
    }
    if (res) errors[fieldName] = res
  }
  return { valid: Object.keys(errors).length === 0, errors }
}
