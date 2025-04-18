import { context, events } from "@budibase/backend-core"
import {
  AutoFieldSubType,
  FieldSubtype,
  FieldType,
  INTERNAL_TABLE_SOURCE_ID,
  InternalTable,
  NumberFieldMetadata,
  RelationshipType,
  Row,
  SaveTableRequest,
  Table,
  TableSourceType,
  User,
  ViewCalculation,
} from "@budibase/types"
import { checkBuilderEndpoint } from "./utilities/TestFunctions"
import * as setup from "./utilities"
import sdk from "../../../sdk"
import * as uuid from "uuid"

import tk from "timekeeper"
import { mocks } from "@budibase/backend-core/tests"
import { TableToBuild } from "../../../tests/utilities/TestConfiguration"

tk.freeze(mocks.date.MOCK_DATE)

const { basicTable } = setup.structures
const ISO_REGEX_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

describe("/tables", () => {
  let request = setup.getRequest()
  let config = setup.getConfig()
  let appId: string

  afterAll(setup.afterAll)

  beforeAll(async () => {
    const app = await config.init()
    appId = app.appId
  })

  describe("create", () => {
    beforeEach(() => {
      jest.clearAllMocks()
    })

    const createTable = (table?: Table) => {
      if (!table) {
        table = basicTable()
      }
      return request
        .post(`/api/tables`)
        .send(table)
        .set(config.defaultHeaders())
        .expect("Content-Type", /json/)
        .expect(200)
    }

    it("returns a success message when the table is successfully created", async () => {
      const res = await createTable()

      expect((res as any).res.statusMessage).toEqual(
        "Table TestTable saved successfully."
      )
      expect(res.body.name).toEqual("TestTable")
      expect(events.table.created).toBeCalledTimes(1)
      expect(events.table.created).toBeCalledWith(res.body)
    })

    it("creates all the passed fields", async () => {
      const tableData: TableToBuild = {
        name: "TestTable",
        type: "table",
        schema: {
          autoId: {
            name: "id",
            type: FieldType.NUMBER,
            subtype: AutoFieldSubType.AUTO_ID,
            autocolumn: true,
            constraints: {
              type: "number",
              presence: false,
            },
          },
        },
        views: {
          "table view": {
            id: "viewId",
            version: 2,
            name: "table view",
            tableId: "tableId",
          },
        },
      }
      const testTable = await config.createTable(tableData)

      const expected: Table = {
        ...tableData,
        type: "table",
        views: {
          "table view": {
            ...tableData.views!["table view"],
            schema: {
              autoId: {
                autocolumn: true,
                constraints: {
                  presence: false,
                  type: "number",
                },
                name: "id",
                type: FieldType.NUMBER,
                subtype: AutoFieldSubType.AUTO_ID,
                visible: false,
              } as NumberFieldMetadata,
            },
          },
        },
        sourceType: TableSourceType.INTERNAL,
        sourceId: expect.any(String),
        _rev: expect.stringMatching(/^1-.+/),
        _id: expect.any(String),
        createdAt: mocks.date.MOCK_DATE.toISOString(),
        updatedAt: mocks.date.MOCK_DATE.toISOString(),
      }
      expect(testTable).toEqual(expected)

      const persistedTable = await config.api.table.get(testTable._id!)
      expect(persistedTable).toEqual(expected)
    })

    it("creates a table via data import", async () => {
      const table: SaveTableRequest = basicTable()
      table.rows = [{ name: "test-name", description: "test-desc" }]

      const res = await createTable(table)

      expect(events.table.created).toBeCalledTimes(1)
      expect(events.table.created).toBeCalledWith(res.body)
      expect(events.table.imported).toBeCalledTimes(1)
      expect(events.table.imported).toBeCalledWith(res.body)
      expect(events.rows.imported).toBeCalledTimes(1)
      expect(events.rows.imported).toBeCalledWith(res.body, 1)
    })

    it("should apply authorization to endpoint", async () => {
      await checkBuilderEndpoint({
        config,
        method: "POST",
        url: `/api/tables`,
        body: basicTable(),
      })
    })
  })

  describe("update", () => {
    it("updates a table", async () => {
      const testTable = await config.createTable()

      const res = await request
        .post(`/api/tables`)
        .send(testTable)
        .set(config.defaultHeaders())
        .expect("Content-Type", /json/)
        .expect(200)

      expect(events.table.updated).toBeCalledTimes(1)
      expect(events.table.updated).toBeCalledWith(res.body)
    })

    it("updates all the row fields for a table when a schema key is renamed", async () => {
      const testTable = await config.createTable()
      await config.createLegacyView({
        name: "TestView",
        field: "Price",
        calculation: ViewCalculation.STATISTICS,
        tableId: testTable._id!,
        schema: {},
        filters: [],
      })

      const testRow = await request
        .post(`/api/${testTable._id}/rows`)
        .send({
          name: "test",
        })
        .set(config.defaultHeaders())
        .expect("Content-Type", /json/)
        .expect(200)

      const updatedTable = await request
        .post(`/api/tables`)
        .send({
          _id: testTable._id,
          _rev: testTable._rev,
          name: "TestTable",
          key: "name",
          _rename: {
            old: "name",
            updated: "updatedName",
          },
          schema: {
            updatedName: { type: "string" },
          },
        })
        .set(config.defaultHeaders())
        .expect("Content-Type", /json/)
        .expect(200)
      expect((updatedTable as any).res.statusMessage).toEqual(
        "Table TestTable saved successfully."
      )
      expect(updatedTable.body.name).toEqual("TestTable")

      const res = await request
        .get(`/api/${testTable._id}/rows/${testRow.body._id}`)
        .set(config.defaultHeaders())
        .expect("Content-Type", /json/)
        .expect(200)

      expect(res.body.updatedName).toEqual("test")
      expect(res.body.name).toBeUndefined()
    })

    it("updates only the passed fields", async () => {
      const testTable = await config.createTable({
        name: "TestTable",
        type: "table",
        schema: {
          autoId: {
            name: "id",
            type: FieldType.NUMBER,
            subtype: AutoFieldSubType.AUTO_ID,
            autocolumn: true,
            constraints: {
              type: "number",
              presence: false,
            },
          },
        },
        views: {
          view1: {
            id: "viewId",
            version: 2,
            name: "table view",
            tableId: "tableId",
          },
        },
      })

      const response = await request
        .post(`/api/tables`)
        .send({
          ...testTable,
          name: "UpdatedName",
        })
        .set(config.defaultHeaders())
        .expect("Content-Type", /json/)
        .expect(200)

      expect(response.body).toEqual({
        ...testTable,
        name: "UpdatedName",
        _rev: expect.stringMatching(/^2-.+/),
      })

      const persistedTable = await config.api.table.get(testTable._id!)
      expect(persistedTable).toEqual({
        ...testTable,
        name: "UpdatedName",
        _rev: expect.stringMatching(/^2-.+/),
      })
    })

    describe("user table", () => {
      it("should add roleId and email field when adjusting user table schema", async () => {
        const res = await request
          .post(`/api/tables`)
          .send({
            ...basicTable(),
            _id: "ta_users",
          })
          .set(config.defaultHeaders())
          .expect("Content-Type", /json/)
          .expect(200)
        expect(res.body.schema.email).toBeDefined()
        expect(res.body.schema.roleId).toBeDefined()
      })
    })

    it("should add a new column for an internal DB table", async () => {
      const saveTableRequest: SaveTableRequest = {
        _add: {
          name: "NEW_COLUMN",
        },
        ...basicTable(),
      }

      const response = await request
        .post(`/api/tables`)
        .send(saveTableRequest)
        .set(config.defaultHeaders())
        .expect("Content-Type", /json/)
        .expect(200)

      const expectedResponse = {
        ...saveTableRequest,
        _rev: expect.stringMatching(/^\d-.+/),
        _id: expect.stringMatching(/^ta_.+/),
        createdAt: expect.stringMatching(ISO_REGEX_PATTERN),
        updatedAt: expect.stringMatching(ISO_REGEX_PATTERN),
        views: {},
      }
      delete expectedResponse._add

      expect(response.status).toBe(200)
      expect(response.body).toEqual(expectedResponse)
    })
  })

  describe("import", () => {
    it("imports rows successfully", async () => {
      const table = await config.createTable()
      const importRequest = {
        schema: table.schema,
        rows: [{ name: "test-name", description: "test-desc" }],
      }

      jest.clearAllMocks()

      await request
        .post(`/api/tables/${table._id}/import`)
        .send(importRequest)
        .set(config.defaultHeaders())
        .expect("Content-Type", /json/)
        .expect(200)

      expect(events.table.created).not.toHaveBeenCalled()
      expect(events.rows.imported).toBeCalledTimes(1)
      expect(events.rows.imported).toBeCalledWith(
        expect.objectContaining({
          name: "TestTable",
          _id: table._id,
        }),
        1
      )
    })

    it("should update Auto ID field after bulk import", async () => {
      const table = await config.createTable({
        name: "TestTable",
        type: "table",
        schema: {
          autoId: {
            name: "id",
            type: FieldType.NUMBER,
            subtype: AutoFieldSubType.AUTO_ID,
            autocolumn: true,
            constraints: {
              type: "number",
              presence: false,
            },
          },
        },
      })

      let row = await config.api.row.save(table._id!, {})
      expect(row.autoId).toEqual(1)

      await config.api.row.bulkImport(table._id!, {
        rows: [{ autoId: 2 }],
        identifierFields: [],
      })

      row = await config.api.row.save(table._id!, {})
      expect(row.autoId).toEqual(3)
    })
  })

  describe("fetch", () => {
    let testTable: Table
    const enrichViewSchemasMock = jest.spyOn(sdk.tables, "enrichViewSchemas")

    beforeEach(async () => {
      testTable = await config.createTable(testTable)
    })

    afterEach(() => {
      delete testTable._rev
    })

    afterAll(() => {
      enrichViewSchemasMock.mockRestore()
    })

    it("returns all the tables for that instance in the response body", async () => {
      const res = await request
        .get(`/api/tables`)
        .set(config.defaultHeaders())
        .expect("Content-Type", /json/)
        .expect(200)

      const table = res.body.find((t: Table) => t._id === testTable._id)
      expect(table).toBeDefined()
      expect(table.name).toEqual(testTable.name)
      expect(table.type).toEqual("table")
      expect(table.sourceType).toEqual("internal")
    })

    it("should apply authorization to endpoint", async () => {
      await checkBuilderEndpoint({
        config,
        method: "GET",
        url: `/api/tables`,
      })
    })

    it("should fetch views", async () => {
      const tableId = config.table!._id!
      const views = [
        await config.api.viewV2.create({ tableId }),
        await config.api.viewV2.create({ tableId }),
      ]

      const res = await request
        .get(`/api/tables`)
        .set(config.defaultHeaders())
        .expect("Content-Type", /json/)
        .expect(200)

      expect(res.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            _id: tableId,
            views: views.reduce((p, c) => {
              p[c.name] = { ...c, schema: expect.anything() }
              return p
            }, {} as any),
          }),
        ])
      )
    })

    it("should enrich the view schemas for viewsV2", async () => {
      const tableId = config.table!._id!
      enrichViewSchemasMock.mockImplementation(t => ({
        ...t,
        views: {
          view1: {
            version: 2,
            name: "view1",
            schema: {},
            id: "new_view_id",
            tableId: t._id!,
          },
        },
      }))

      await config.api.viewV2.create({ tableId })
      await config.createLegacyView()

      const res = await config.api.table.fetch()

      expect(res).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            _id: tableId,
            views: {
              view1: {
                version: 2,
                name: "view1",
                schema: {},
                id: "new_view_id",
                tableId,
              },
            },
          }),
        ])
      )
    })
  })

  describe("indexing", () => {
    it("should be able to create a table with indexes", async () => {
      await context.doInAppContext(appId, async () => {
        const db = context.getAppDB()
        const indexCount = (await db.getIndexes()).total_rows
        const table = basicTable()
        table.indexes = ["name"]
        const res = await request
          .post(`/api/tables`)
          .send(table)
          .set(config.defaultHeaders())
          .expect("Content-Type", /json/)
          .expect(200)
        expect(res.body._id).toBeDefined()
        expect(res.body._rev).toBeDefined()
        expect((await db.getIndexes()).total_rows).toEqual(indexCount + 1)
        // update index to see what happens
        table.indexes = ["name", "description"]
        await request
          .post(`/api/tables`)
          .send({
            ...table,
            _id: res.body._id,
            _rev: res.body._rev,
          })
          .set(config.defaultHeaders())
          .expect("Content-Type", /json/)
          .expect(200)
        // shouldn't have created a new index
        expect((await db.getIndexes()).total_rows).toEqual(indexCount + 1)
      })
    })
  })

  describe("destroy", () => {
    let testTable: Table

    beforeEach(async () => {
      testTable = await config.createTable()
    })

    it("returns a success response when a table is deleted.", async () => {
      const res = await request
        .delete(`/api/tables/${testTable._id}/${testTable._rev}`)
        .set(config.defaultHeaders())
        .expect("Content-Type", /json/)
        .expect(200)
      expect(res.body.message).toEqual(`Table ${testTable._id} deleted.`)
      expect(events.table.deleted).toBeCalledTimes(1)
      expect(events.table.deleted).toBeCalledWith({
        ...testTable,
        tableId: testTable._id,
      })
    })

    it("deletes linked references to the table after deletion", async () => {
      const linkedTable = await config.createTable({
        name: "LinkedTable",
        type: "table",
        schema: {
          name: {
            type: FieldType.STRING,
            name: "name",
            constraints: {
              type: "string",
            },
          },
          TestTable: {
            type: FieldType.LINK,
            relationshipType: RelationshipType.ONE_TO_MANY,
            name: "TestTable",
            fieldName: "TestTable",
            tableId: testTable._id!,
            constraints: {
              type: "array",
            },
          },
        },
      })

      const res = await request
        .delete(`/api/tables/${testTable._id}/${testTable._rev}`)
        .set(config.defaultHeaders())
        .expect("Content-Type", /json/)
        .expect(200)
      expect(res.body.message).toEqual(`Table ${testTable._id} deleted.`)
      const dependentTable = await config.api.table.get(linkedTable._id!)
      expect(dependentTable.schema.TestTable).not.toBeDefined()
    })

    it("should apply authorization to endpoint", async () => {
      await checkBuilderEndpoint({
        config,
        method: "DELETE",
        url: `/api/tables/${testTable._id}/${testTable._rev}`,
      })
    })
  })

  describe("migrate", () => {
    let users: User[]
    beforeAll(async () => {
      users = await Promise.all([
        config.createUser({ email: `${uuid.v4()}@example.com` }),
        config.createUser({ email: `${uuid.v4()}@example.com` }),
        config.createUser({ email: `${uuid.v4()}@example.com` }),
      ])
    })

    it("should successfully migrate a one-to-many user relationship to a user column", async () => {
      const table = await config.api.table.save({
        name: "table",
        type: "table",
        sourceId: INTERNAL_TABLE_SOURCE_ID,
        sourceType: TableSourceType.INTERNAL,
        schema: {
          "user relationship": {
            type: FieldType.LINK,
            fieldName: "test",
            name: "user relationship",
            constraints: {
              type: "array",
              presence: false,
            },
            relationshipType: RelationshipType.ONE_TO_MANY,
            tableId: InternalTable.USER_METADATA,
          },
        },
      })

      const rows = await Promise.all(
        users.map(u =>
          config.api.row.save(table._id!, { "user relationship": [u] })
        )
      )

      await config.api.table.migrate(table._id!, {
        oldColumn: table.schema["user relationship"],
        newColumn: {
          name: "user column",
          type: FieldType.BB_REFERENCE,
          subtype: FieldSubtype.USER,
        },
      })

      const migratedTable = await config.api.table.get(table._id!)
      expect(migratedTable.schema["user column"]).toBeDefined()
      expect(migratedTable.schema["user relationship"]).not.toBeDefined()

      const migratedRows = await config.api.row.fetch(table._id!)

      rows.sort((a, b) => a._id!.localeCompare(b._id!))
      migratedRows.sort((a, b) => a._id!.localeCompare(b._id!))

      for (const [i, row] of rows.entries()) {
        const migratedRow = migratedRows[i]
        expect(migratedRow["user column"]).toBeDefined()
        expect(migratedRow["user relationship"]).not.toBeDefined()
        expect(row["user relationship"][0]._id).toEqual(
          migratedRow["user column"][0]._id
        )
      }
    })

    it("should succeed when the row is created from the other side of the relationship", async () => {
      // We found a bug just after releasing this feature where if the row was created from the
      // users table, not the table linking to it, the migration would succeed but lose the data.
      // This happened because the order of the documents in the link was reversed.
      const table = await config.api.table.save({
        name: "table",
        type: "table",
        sourceId: INTERNAL_TABLE_SOURCE_ID,
        sourceType: TableSourceType.INTERNAL,
        schema: {
          "user relationship": {
            type: FieldType.LINK,
            fieldName: "test",
            name: "user relationship",
            constraints: {
              type: "array",
              presence: false,
            },
            relationshipType: RelationshipType.MANY_TO_ONE,
            tableId: InternalTable.USER_METADATA,
          },
        },
      })

      let testRow = await config.api.row.save(table._id!, {})

      await Promise.all(
        users.map(u =>
          config.api.row.patch(InternalTable.USER_METADATA, {
            tableId: InternalTable.USER_METADATA,
            _rev: u._rev!,
            _id: u._id!,
            test: [testRow],
          })
        )
      )

      await config.api.table.migrate(table._id!, {
        oldColumn: table.schema["user relationship"],
        newColumn: {
          name: "user column",
          type: FieldType.BB_REFERENCE,
          subtype: FieldSubtype.USERS,
        },
      })

      const migratedTable = await config.api.table.get(table._id!)
      expect(migratedTable.schema["user column"]).toBeDefined()
      expect(migratedTable.schema["user relationship"]).not.toBeDefined()

      const migratedRow = await config.api.row.get(table._id!, testRow._id!)

      expect(migratedRow["user column"]).toBeDefined()
      expect(migratedRow["user relationship"]).not.toBeDefined()
      expect(migratedRow["user column"]).toHaveLength(3)
      expect(migratedRow["user column"].map((u: Row) => u._id)).toEqual(
        expect.arrayContaining(users.map(u => u._id))
      )
    })

    it("should successfully migrate a many-to-many user relationship to a users column", async () => {
      const table = await config.api.table.save({
        name: "table",
        type: "table",
        sourceId: INTERNAL_TABLE_SOURCE_ID,
        sourceType: TableSourceType.INTERNAL,
        schema: {
          "user relationship": {
            type: FieldType.LINK,
            fieldName: "test",
            name: "user relationship",
            constraints: {
              type: "array",
              presence: false,
            },
            relationshipType: RelationshipType.MANY_TO_MANY,
            tableId: InternalTable.USER_METADATA,
          },
        },
      })

      const row1 = await config.api.row.save(table._id!, {
        "user relationship": [users[0], users[1]],
      })

      const row2 = await config.api.row.save(table._id!, {
        "user relationship": [users[1], users[2]],
      })

      await config.api.table.migrate(table._id!, {
        oldColumn: table.schema["user relationship"],
        newColumn: {
          name: "user column",
          type: FieldType.BB_REFERENCE,
          subtype: FieldSubtype.USERS,
        },
      })

      const migratedTable = await config.api.table.get(table._id!)
      expect(migratedTable.schema["user column"]).toBeDefined()
      expect(migratedTable.schema["user relationship"]).not.toBeDefined()

      const row1Migrated = await config.api.row.get(table._id!, row1._id!)
      expect(row1Migrated["user relationship"]).not.toBeDefined()
      expect(row1Migrated["user column"].map((r: Row) => r._id)).toEqual(
        expect.arrayContaining([users[0]._id, users[1]._id])
      )

      const row2Migrated = await config.api.row.get(table._id!, row2._id!)
      expect(row2Migrated["user relationship"]).not.toBeDefined()
      expect(row2Migrated["user column"].map((r: Row) => r._id)).toEqual(
        expect.arrayContaining([users[1]._id, users[2]._id])
      )
    })

    it("should successfully migrate a many-to-one user relationship to a users column", async () => {
      const table = await config.api.table.save({
        name: "table",
        type: "table",
        sourceId: INTERNAL_TABLE_SOURCE_ID,
        sourceType: TableSourceType.INTERNAL,
        schema: {
          "user relationship": {
            type: FieldType.LINK,
            fieldName: "test",
            name: "user relationship",
            constraints: {
              type: "array",
              presence: false,
            },
            relationshipType: RelationshipType.MANY_TO_ONE,
            tableId: InternalTable.USER_METADATA,
          },
        },
      })

      const row1 = await config.api.row.save(table._id!, {
        "user relationship": [users[0], users[1]],
      })

      const row2 = await config.api.row.save(table._id!, {
        "user relationship": [users[2]],
      })

      await config.api.table.migrate(table._id!, {
        oldColumn: table.schema["user relationship"],
        newColumn: {
          name: "user column",
          type: FieldType.BB_REFERENCE,
          subtype: FieldSubtype.USERS,
        },
      })

      const migratedTable = await config.api.table.get(table._id!)
      expect(migratedTable.schema["user column"]).toBeDefined()
      expect(migratedTable.schema["user relationship"]).not.toBeDefined()

      const row1Migrated = await config.api.row.get(table._id!, row1._id!)
      expect(row1Migrated["user relationship"]).not.toBeDefined()
      expect(row1Migrated["user column"].map((r: Row) => r._id)).toEqual(
        expect.arrayContaining([users[0]._id, users[1]._id])
      )

      const row2Migrated = await config.api.row.get(table._id!, row2._id!)
      expect(row2Migrated["user relationship"]).not.toBeDefined()
      expect(row2Migrated["user column"].map((r: Row) => r._id)).toEqual([
        users[2]._id,
      ])
    })

    describe("unhappy paths", () => {
      let table: Table
      beforeAll(async () => {
        table = await config.api.table.save({
          name: "table",
          type: "table",
          sourceId: INTERNAL_TABLE_SOURCE_ID,
          sourceType: TableSourceType.INTERNAL,
          schema: {
            "user relationship": {
              type: FieldType.LINK,
              fieldName: "test",
              name: "user relationship",
              constraints: {
                type: "array",
                presence: false,
              },
              relationshipType: RelationshipType.MANY_TO_ONE,
              tableId: InternalTable.USER_METADATA,
            },
            num: {
              type: FieldType.NUMBER,
              name: "num",
              constraints: {
                type: "number",
                presence: false,
              },
            },
          },
        })
      })

      it("should fail if the new column name is blank", async () => {
        await config.api.table.migrate(
          table._id!,
          {
            oldColumn: table.schema["user relationship"],
            newColumn: {
              name: "",
              type: FieldType.BB_REFERENCE,
              subtype: FieldSubtype.USERS,
            },
          },
          { status: 400 }
        )
      })

      it("should fail if the new column name is a reserved name", async () => {
        await config.api.table.migrate(
          table._id!,
          {
            oldColumn: table.schema["user relationship"],
            newColumn: {
              name: "_id",
              type: FieldType.BB_REFERENCE,
              subtype: FieldSubtype.USERS,
            },
          },
          { status: 400 }
        )
      })

      it("should fail if the new column name is the same as an existing column", async () => {
        await config.api.table.migrate(
          table._id!,
          {
            oldColumn: table.schema["user relationship"],
            newColumn: {
              name: "num",
              type: FieldType.BB_REFERENCE,
              subtype: FieldSubtype.USERS,
            },
          },
          { status: 400 }
        )
      })

      it("should fail if the old column name isn't a column in the table", async () => {
        await config.api.table.migrate(
          table._id!,
          {
            oldColumn: {
              name: "not a column",
              type: FieldType.BB_REFERENCE,
              subtype: FieldSubtype.USERS,
            },
            newColumn: {
              name: "new column",
              type: FieldType.BB_REFERENCE,
              subtype: FieldSubtype.USERS,
            },
          },
          { status: 400 }
        )
      })
    })
  })
})
