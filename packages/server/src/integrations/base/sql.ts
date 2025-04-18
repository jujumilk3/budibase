import { Knex, knex } from "knex"
import { db as dbCore } from "@budibase/backend-core"
import { QueryOptions } from "../../definitions/datasource"
import { isIsoDateString, SqlClient, isValidFilter } from "../utils"
import SqlTableQueryBuilder from "./sqlTable"
import {
  BBReferenceFieldMetadata,
  FieldSchema,
  FieldSubtype,
  FieldType,
  JsonFieldMetadata,
  Operation,
  QueryJson,
  RelationshipsJson,
  SearchFilters,
  SortDirection,
  Table,
} from "@budibase/types"
import environment from "../../environment"

type QueryFunction = (query: Knex.SqlNative, operation: Operation) => any

const envLimit = environment.SQL_MAX_ROWS
  ? parseInt(environment.SQL_MAX_ROWS)
  : null
const BASE_LIMIT = envLimit || 5000

// these are invalid dates sent by the client, need to convert them to a real max date
const MIN_ISO_DATE = "0000-00-00T00:00:00.000Z"
const MAX_ISO_DATE = "9999-00-00T00:00:00.000Z"

function likeKey(client: string, key: string): string {
  let start: string, end: string
  switch (client) {
    case SqlClient.MY_SQL:
      start = end = "`"
      break
    case SqlClient.ORACLE:
    case SqlClient.POSTGRES:
      start = end = '"'
      break
    case SqlClient.MS_SQL:
      start = "["
      end = "]"
      break
    default:
      throw "Unknown client"
  }
  const parts = key.split(".")
  key = parts.map(part => `${start}${part}${end}`).join(".")
  return key
}

function parse(input: any) {
  if (Array.isArray(input)) {
    return JSON.stringify(input)
  }
  if (input == undefined) {
    return null
  }
  if (typeof input !== "string") {
    return input
  }
  if (input === MAX_ISO_DATE || input === MIN_ISO_DATE) {
    return null
  }
  if (isIsoDateString(input)) {
    return new Date(input.trim())
  }
  return input
}

function parseBody(body: any) {
  for (let [key, value] of Object.entries(body)) {
    body[key] = parse(value)
  }
  return body
}

function parseFilters(filters: SearchFilters | undefined): SearchFilters {
  if (!filters) {
    return {}
  }
  for (let [key, value] of Object.entries(filters)) {
    let parsed
    if (typeof value === "object") {
      parsed = parseFilters(value)
    } else {
      parsed = parse(value)
    }
    // @ts-ignore
    filters[key] = parsed
  }
  return filters
}

function generateSelectStatement(
  json: QueryJson,
  knex: Knex
): (string | Knex.Raw)[] | "*" {
  const { resource, meta } = json

  if (!resource) {
    return "*"
  }

  const schema = meta?.table?.schema
  return resource.fields.map(field => {
    const fieldNames = field.split(/\./g)
    const tableName = fieldNames[0]
    const columnName = fieldNames[1]
    if (
      columnName &&
      schema?.[columnName] &&
      knex.client.config.client === SqlClient.POSTGRES
    ) {
      const externalType = schema[columnName].externalType
      if (externalType?.includes("money")) {
        return knex.raw(
          `"${tableName}"."${columnName}"::money::numeric as "${field}"`
        )
      }
    }
    return `${field} as ${field}`
  })
}

class InternalBuilder {
  private readonly client: string

  constructor(client: string) {
    this.client = client
  }

  // right now we only do filters on the specific table being queried
  addFilters(
    query: Knex.QueryBuilder,
    filters: SearchFilters | undefined,
    tableName: string,
    opts: { aliases?: Record<string, string>; relationship?: boolean }
  ): Knex.QueryBuilder {
    function getTableName(name: string) {
      const alias = opts.aliases?.[name]
      return alias || name
    }
    function iterate(
      structure: { [key: string]: any },
      fn: (key: string, value: any) => void
    ) {
      for (let [key, value] of Object.entries(structure)) {
        const updatedKey = dbCore.removeKeyNumbering(key)
        const isRelationshipField = updatedKey.includes(".")
        if (!opts.relationship && !isRelationshipField) {
          fn(`${getTableName(tableName)}.${updatedKey}`, value)
        }
        if (opts.relationship && isRelationshipField) {
          const [filterTableName, property] = updatedKey.split(".")
          fn(`${getTableName(filterTableName)}.${property}`, value)
        }
      }
    }

    const like = (key: string, value: any) => {
      const fnc = allOr ? "orWhere" : "where"
      // postgres supports ilike, nothing else does
      if (this.client === SqlClient.POSTGRES) {
        query = query[fnc](key, "ilike", `%${value}%`)
      } else {
        const rawFnc = `${fnc}Raw`
        // @ts-ignore
        query = query[rawFnc](`LOWER(${likeKey(this.client, key)}) LIKE ?`, [
          `%${value.toLowerCase()}%`,
        ])
      }
    }

    const contains = (mode: object, any: boolean = false) => {
      const fnc = allOr ? "orWhere" : "where"
      const rawFnc = `${fnc}Raw`
      const not = mode === filters?.notContains ? "NOT " : ""
      function stringifyArray(value: Array<any>, quoteStyle = '"'): string {
        for (let i in value) {
          if (typeof value[i] === "string") {
            value[i] = `${quoteStyle}${value[i]}${quoteStyle}`
          }
        }
        return `[${value.join(",")}]`
      }
      if (this.client === SqlClient.POSTGRES) {
        iterate(mode, (key: string, value: Array<any>) => {
          const wrap = any ? "" : "'"
          const containsOp = any ? "\\?| array" : "@>"
          const fieldNames = key.split(/\./g)
          const tableName = fieldNames[0]
          const columnName = fieldNames[1]
          // @ts-ignore
          query = query[rawFnc](
            `${not}"${tableName}"."${columnName}"::jsonb ${containsOp} ${wrap}${stringifyArray(
              value,
              any ? "'" : '"'
            )}${wrap}`
          )
        })
      } else if (this.client === SqlClient.MY_SQL) {
        const jsonFnc = any ? "JSON_OVERLAPS" : "JSON_CONTAINS"
        iterate(mode, (key: string, value: Array<any>) => {
          // @ts-ignore
          query = query[rawFnc](
            `${not}${jsonFnc}(${key}, '${stringifyArray(value)}')`
          )
        })
      } else {
        const andOr = mode === filters?.containsAny ? " OR " : " AND "
        iterate(mode, (key: string, value: Array<any>) => {
          let statement = ""
          for (let i in value) {
            if (typeof value[i] === "string") {
              value[i] = `%"${value[i].toLowerCase()}"%`
            } else {
              value[i] = `%${value[i]}%`
            }
            statement +=
              (statement ? andOr : "") +
              `LOWER(${likeKey(this.client, key)}) LIKE ?`
          }
          // @ts-ignore
          query = query[rawFnc](`${not}(${statement})`, value)
        })
      }
    }

    if (!filters) {
      return query
    }
    filters = parseFilters(filters)
    // if all or specified in filters, then everything is an or
    const allOr = filters.allOr
    if (filters.oneOf) {
      iterate(filters.oneOf, (key, array) => {
        const fnc = allOr ? "orWhereIn" : "whereIn"
        query = query[fnc](key, Array.isArray(array) ? array : [array])
      })
    }
    if (filters.string) {
      iterate(filters.string, (key, value) => {
        const fnc = allOr ? "orWhere" : "where"
        // postgres supports ilike, nothing else does
        if (this.client === SqlClient.POSTGRES) {
          query = query[fnc](key, "ilike", `${value}%`)
        } else {
          const rawFnc = `${fnc}Raw`
          // @ts-ignore
          query = query[rawFnc](`LOWER(${likeKey(this.client, key)}) LIKE ?`, [
            `${value.toLowerCase()}%`,
          ])
        }
      })
    }
    if (filters.fuzzy) {
      iterate(filters.fuzzy, like)
    }
    if (filters.range) {
      iterate(filters.range, (key, value) => {
        const isEmptyObject = (val: any) => {
          return (
            val &&
            Object.keys(val).length === 0 &&
            Object.getPrototypeOf(val) === Object.prototype
          )
        }
        if (isEmptyObject(value.low)) {
          value.low = ""
        }
        if (isEmptyObject(value.high)) {
          value.high = ""
        }
        const lowValid = isValidFilter(value.low),
          highValid = isValidFilter(value.high)
        if (lowValid && highValid) {
          // Use a between operator if we have 2 valid range values
          const fnc = allOr ? "orWhereBetween" : "whereBetween"
          query = query[fnc](key, [value.low, value.high])
        } else if (lowValid) {
          // Use just a single greater than operator if we only have a low
          const fnc = allOr ? "orWhere" : "where"
          query = query[fnc](key, ">", value.low)
        } else if (highValid) {
          // Use just a single less than operator if we only have a high
          const fnc = allOr ? "orWhere" : "where"
          query = query[fnc](key, "<", value.high)
        }
      })
    }
    if (filters.equal) {
      iterate(filters.equal, (key, value) => {
        const fnc = allOr ? "orWhere" : "where"
        query = query[fnc]({ [key]: value })
      })
    }
    if (filters.notEqual) {
      iterate(filters.notEqual, (key, value) => {
        const fnc = allOr ? "orWhereNot" : "whereNot"
        query = query[fnc]({ [key]: value })
      })
    }
    if (filters.empty) {
      iterate(filters.empty, key => {
        const fnc = allOr ? "orWhereNull" : "whereNull"
        query = query[fnc](key)
      })
    }
    if (filters.notEmpty) {
      iterate(filters.notEmpty, key => {
        const fnc = allOr ? "orWhereNotNull" : "whereNotNull"
        query = query[fnc](key)
      })
    }
    if (filters.contains) {
      contains(filters.contains)
    }
    if (filters.notContains) {
      contains(filters.notContains)
    }
    if (filters.containsAny) {
      contains(filters.containsAny, true)
    }
    return query
  }

  addSorting(query: Knex.QueryBuilder, json: QueryJson): Knex.QueryBuilder {
    let { sort, paginate } = json
    const table = json.meta?.table
    const aliases = json.tableAliases
    const aliased =
      table?.name && aliases?.[table.name] ? aliases[table.name] : table?.name
    if (sort && Object.keys(sort || {}).length > 0) {
      for (let [key, value] of Object.entries(sort)) {
        const direction =
          value.direction === SortDirection.ASCENDING ? "asc" : "desc"
        query = query.orderBy(`${aliased}.${key}`, direction)
      }
    } else if (this.client === SqlClient.MS_SQL && paginate?.limit) {
      // @ts-ignore
      query = query.orderBy(`${aliased}.${table?.primary[0]}`)
    }
    return query
  }

  tableNameWithSchema(
    tableName: string,
    opts?: { alias?: string; schema?: string }
  ) {
    let withSchema = opts?.schema ? `${opts.schema}.${tableName}` : tableName
    if (opts?.alias) {
      withSchema += ` as ${opts.alias}`
    }
    return withSchema
  }

  addRelationships(
    query: Knex.QueryBuilder,
    fromTable: string,
    relationships: RelationshipsJson[] | undefined,
    schema: string | undefined,
    aliases?: Record<string, string>
  ): Knex.QueryBuilder {
    if (!relationships) {
      return query
    }
    const tableSets: Record<string, [RelationshipsJson]> = {}
    // aggregate into table sets (all the same to tables)
    for (let relationship of relationships) {
      const keyObj: { toTable: string; throughTable: string | undefined } = {
        toTable: relationship.tableName,
        throughTable: undefined,
      }
      if (relationship.through) {
        keyObj.throughTable = relationship.through
      }
      const key = JSON.stringify(keyObj)
      if (tableSets[key]) {
        tableSets[key].push(relationship)
      } else {
        tableSets[key] = [relationship]
      }
    }
    for (let [key, relationships] of Object.entries(tableSets)) {
      const { toTable, throughTable } = JSON.parse(key)
      const toAlias = aliases?.[toTable] || toTable,
        throughAlias = aliases?.[throughTable] || throughTable,
        fromAlias = aliases?.[fromTable] || fromTable
      let toTableWithSchema = this.tableNameWithSchema(toTable, {
        alias: toAlias,
        schema,
      })
      let throughTableWithSchema = this.tableNameWithSchema(throughTable, {
        alias: throughAlias,
        schema,
      })
      if (!throughTable) {
        // @ts-ignore
        query = query.leftJoin(toTableWithSchema, function () {
          for (let relationship of relationships) {
            const from = relationship.from,
              to = relationship.to
            // @ts-ignore
            this.orOn(`${fromAlias}.${from}`, "=", `${toAlias}.${to}`)
          }
        })
      } else {
        query = query
          // @ts-ignore
          .leftJoin(throughTableWithSchema, function () {
            for (let relationship of relationships) {
              const fromPrimary = relationship.fromPrimary
              const from = relationship.from
              // @ts-ignore
              this.orOn(
                `${fromAlias}.${fromPrimary}`,
                "=",
                `${throughAlias}.${from}`
              )
            }
          })
          .leftJoin(toTableWithSchema, function () {
            for (let relationship of relationships) {
              const toPrimary = relationship.toPrimary
              const to = relationship.to
              // @ts-ignore
              this.orOn(`${toAlias}.${toPrimary}`, `${throughAlias}.${to}`)
            }
          })
      }
    }
    return query.limit(BASE_LIMIT)
  }

  knexWithAlias(
    knex: Knex,
    endpoint: QueryJson["endpoint"],
    aliases?: QueryJson["tableAliases"]
  ): Knex.QueryBuilder {
    const tableName = endpoint.entityId
    const tableAlias = aliases?.[tableName]
    let table: string | Record<string, string> = tableName
    if (tableAlias) {
      table = { [tableAlias]: tableName }
    }
    let query = knex(table)
    if (endpoint.schema) {
      query = query.withSchema(endpoint.schema)
    }
    return query
  }

  create(knex: Knex, json: QueryJson, opts: QueryOptions): Knex.QueryBuilder {
    const { endpoint, body } = json
    let query = this.knexWithAlias(knex, endpoint)
    const parsedBody = parseBody(body)
    // make sure no null values in body for creation
    for (let [key, value] of Object.entries(parsedBody)) {
      if (value == null) {
        delete parsedBody[key]
      }
    }

    // mysql can't use returning
    if (opts.disableReturning) {
      return query.insert(parsedBody)
    } else {
      return query.insert(parsedBody).returning("*")
    }
  }

  bulkCreate(knex: Knex, json: QueryJson): Knex.QueryBuilder {
    const { endpoint, body } = json
    let query = this.knexWithAlias(knex, endpoint)
    if (!Array.isArray(body)) {
      return query
    }
    const parsedBody = body.map(row => parseBody(row))
    return query.insert(parsedBody)
  }

  read(knex: Knex, json: QueryJson, limit: number): Knex.QueryBuilder {
    let { endpoint, resource, filters, paginate, relationships, tableAliases } =
      json

    const tableName = endpoint.entityId
    // select all if not specified
    if (!resource) {
      resource = { fields: [] }
    }
    let selectStatement: string | (string | Knex.Raw)[] = "*"
    // handle select
    if (resource.fields && resource.fields.length > 0) {
      // select the resources as the format "table.columnName" - this is what is provided
      // by the resource builder further up
      selectStatement = generateSelectStatement(json, knex)
    }
    let foundLimit = limit || BASE_LIMIT
    // handle pagination
    let foundOffset: number | null = null
    if (paginate && paginate.page && paginate.limit) {
      // @ts-ignore
      const page = paginate.page <= 1 ? 0 : paginate.page - 1
      const offset = page * paginate.limit
      foundLimit = paginate.limit
      foundOffset = offset
    } else if (paginate && paginate.limit) {
      foundLimit = paginate.limit
    }
    // start building the query
    let query = this.knexWithAlias(knex, endpoint, tableAliases)
    query = query.limit(foundLimit)
    if (foundOffset) {
      query = query.offset(foundOffset)
    }
    query = this.addFilters(query, filters, tableName, {
      aliases: tableAliases,
    })
    // add sorting to pre-query
    query = this.addSorting(query, json)
    const alias = tableAliases?.[tableName] || tableName
    let preQuery = knex({
      [alias]: query,
    } as any).select(selectStatement) as any
    // have to add after as well (this breaks MS-SQL)
    if (this.client !== SqlClient.MS_SQL) {
      preQuery = this.addSorting(preQuery, json)
    }
    // handle joins
    query = this.addRelationships(
      preQuery,
      tableName,
      relationships,
      endpoint.schema,
      tableAliases
    )
    return this.addFilters(query, filters, tableName, {
      relationship: true,
      aliases: tableAliases,
    })
  }

  update(knex: Knex, json: QueryJson, opts: QueryOptions): Knex.QueryBuilder {
    const { endpoint, body, filters, tableAliases } = json
    let query = this.knexWithAlias(knex, endpoint, tableAliases)
    const parsedBody = parseBody(body)
    query = this.addFilters(query, filters, endpoint.entityId, {
      aliases: tableAliases,
    })
    // mysql can't use returning
    if (opts.disableReturning) {
      return query.update(parsedBody)
    } else {
      return query.update(parsedBody).returning("*")
    }
  }

  delete(knex: Knex, json: QueryJson, opts: QueryOptions): Knex.QueryBuilder {
    const { endpoint, filters, tableAliases } = json
    let query = this.knexWithAlias(knex, endpoint, tableAliases)
    query = this.addFilters(query, filters, endpoint.entityId, {
      aliases: tableAliases,
    })
    // mysql can't use returning
    if (opts.disableReturning) {
      return query.delete()
    } else {
      return query.delete().returning(generateSelectStatement(json, knex))
    }
  }
}

class SqlQueryBuilder extends SqlTableQueryBuilder {
  private readonly limit: number
  // pass through client to get flavour of SQL
  constructor(client: string, limit: number = BASE_LIMIT) {
    super(client)
    this.limit = limit
  }

  /**
   * @param json The JSON query DSL which is to be converted to SQL.
   * @param opts extra options which are to be passed into the query builder, e.g. disableReturning
   * which for the sake of mySQL stops adding the returning statement to inserts, updates and deletes.
   * @return the query ready to be passed to the driver.
   */
  _query(json: QueryJson, opts: QueryOptions = {}): Knex.SqlNative | Knex.Sql {
    const sqlClient = this.getSqlClient()
    const client = knex({ client: sqlClient })
    let query: Knex.QueryBuilder
    const builder = new InternalBuilder(sqlClient)
    switch (this._operation(json)) {
      case Operation.CREATE:
        query = builder.create(client, json, opts)
        break
      case Operation.READ:
        query = builder.read(client, json, this.limit)
        break
      case Operation.UPDATE:
        query = builder.update(client, json, opts)
        break
      case Operation.DELETE:
        query = builder.delete(client, json, opts)
        break
      case Operation.BULK_CREATE:
        query = builder.bulkCreate(client, json)
        break
      case Operation.CREATE_TABLE:
      case Operation.UPDATE_TABLE:
      case Operation.DELETE_TABLE:
        return this._tableQuery(json)
      default:
        throw `Operation type is not supported by SQL query builder`
    }
    return query.toSQL().toNative()
  }

  async getReturningRow(queryFn: QueryFunction, json: QueryJson) {
    if (!json.extra || !json.extra.idFilter) {
      return {}
    }
    const input = this._query({
      endpoint: {
        ...json.endpoint,
        operation: Operation.READ,
      },
      resource: {
        fields: [],
      },
      filters: json.extra?.idFilter,
      paginate: {
        limit: 1,
      },
      meta: json.meta,
    })
    return queryFn(input, Operation.READ)
  }

  // when creating if an ID has been inserted need to make sure
  // the id filter is enriched with it before trying to retrieve the row
  checkLookupKeys(id: any, json: QueryJson) {
    if (!id || !json.meta?.table || !json.meta.table.primary) {
      return json
    }
    const primaryKey = json.meta.table.primary?.[0]
    json.extra = {
      idFilter: {
        equal: {
          [primaryKey]: id,
        },
      },
    }
    return json
  }

  // this function recreates the returning functionality of postgres
  async queryWithReturning(
    json: QueryJson,
    queryFn: QueryFunction,
    processFn: Function = (result: any) => result
  ) {
    const sqlClient = this.getSqlClient()
    const operation = this._operation(json)
    const input = this._query(json, { disableReturning: true })
    if (Array.isArray(input)) {
      const responses = []
      for (let query of input) {
        responses.push(await queryFn(query, operation))
      }
      return responses
    }
    let row
    // need to manage returning, a feature mySQL can't do
    if (operation === Operation.DELETE) {
      row = processFn(await this.getReturningRow(queryFn, json))
    }
    const response = await queryFn(input, operation)
    const results = processFn(response)
    // same as delete, manage returning
    if (operation === Operation.CREATE || operation === Operation.UPDATE) {
      let id
      if (sqlClient === SqlClient.MS_SQL) {
        id = results?.[0].id
      } else if (sqlClient === SqlClient.MY_SQL) {
        id = results?.insertId
      }
      row = processFn(
        await this.getReturningRow(queryFn, this.checkLookupKeys(id, json))
      )
    }
    if (operation !== Operation.READ) {
      return row
    }
    return results.length ? results : [{ [operation.toLowerCase()]: true }]
  }

  convertJsonStringColumns(
    table: Table,
    results: Record<string, any>[]
  ): Record<string, any>[] {
    for (const [name, field] of Object.entries(table.schema)) {
      if (!this._isJsonColumn(field)) {
        continue
      }
      const fullName = `${table.name}.${name}`
      for (let row of results) {
        if (typeof row[fullName] === "string") {
          row[fullName] = JSON.parse(row[fullName])
        }
        if (typeof row[name] === "string") {
          row[name] = JSON.parse(row[name])
        }
      }
    }
    return results
  }

  _isJsonColumn(
    field: FieldSchema
  ): field is JsonFieldMetadata | BBReferenceFieldMetadata {
    return (
      field.type === FieldType.JSON ||
      (field.type === FieldType.BB_REFERENCE &&
        field.subtype === FieldSubtype.USERS)
    )
  }

  log(query: string, values?: any[]) {
    if (!environment.SQL_LOGGING_ENABLE) {
      return
    }
    const sqlClient = this.getSqlClient()
    let string = `[SQL] [${sqlClient.toUpperCase()}] query="${query}"`
    if (values) {
      string += ` values="${values.join(", ")}"`
    }
    console.log(string)
  }
}

export default SqlQueryBuilder
