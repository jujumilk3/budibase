import { databaseTestProviders } from "../../../integrations/tests/utils"

import tk from "timekeeper"
import { outputProcessing } from "../../../utilities/rowProcessor"
import * as setup from "./utilities"
import { context, InternalTable, roles, tenancy } from "@budibase/backend-core"
import { quotas } from "@budibase/pro"
import {
  AutoFieldSubType,
  Datasource,
  DeleteRow,
  FieldSchema,
  FieldType,
  FieldTypeSubtypes,
  FormulaType,
  INTERNAL_TABLE_SOURCE_ID,
  PermissionLevel,
  QuotaUsageType,
  RelationshipType,
  Row,
  SaveTableRequest,
  SearchQueryOperators,
  SortOrder,
  SortType,
  StaticQuotaName,
  Table,
  TableSourceType,
  ViewV2,
} from "@budibase/types"
import {
  expectAnyExternalColsAttributes,
  expectAnyInternalColsAttributes,
  generator,
  mocks,
} from "@budibase/backend-core/tests"
import _, { merge } from "lodash"
import * as uuid from "uuid"

const timestamp = new Date("2023-01-26T11:48:57.597Z").toISOString()
tk.freeze(timestamp)

jest.unmock("mysql2")
jest.unmock("mysql2/promise")
jest.unmock("mssql")

describe.each([
  ["internal", undefined],
  ["postgres", databaseTestProviders.postgres],
  ["mysql", databaseTestProviders.mysql],
  ["mssql", databaseTestProviders.mssql],
  ["mariadb", databaseTestProviders.mariadb],
])("/rows (%s)", (__, dsProvider) => {
  const isInternal = dsProvider === undefined
  const config = setup.getConfig()

  let table: Table
  let datasource: Datasource | undefined

  beforeAll(async () => {
    await config.init()
    if (dsProvider) {
      datasource = await config.createDatasource({
        datasource: await dsProvider.datasource(),
      })
    }
  })

  afterAll(async () => {
    if (dsProvider) {
      await dsProvider.stop()
    }
    setup.afterAll()
  })

  function saveTableRequest(
    ...overrides: Partial<SaveTableRequest>[]
  ): SaveTableRequest {
    const req: SaveTableRequest = {
      name: uuid.v4().substring(0, 16),
      type: "table",
      sourceType: datasource
        ? TableSourceType.EXTERNAL
        : TableSourceType.INTERNAL,
      sourceId: datasource ? datasource._id! : INTERNAL_TABLE_SOURCE_ID,
      primary: ["id"],
      schema: {
        id: {
          type: FieldType.AUTO,
          name: "id",
          autocolumn: true,
          constraints: {
            presence: true,
          },
        },
      },
    }
    return merge(req, ...overrides)
  }

  function defaultTable(
    ...overrides: Partial<SaveTableRequest>[]
  ): SaveTableRequest {
    return saveTableRequest(
      {
        primaryDisplay: "name",
        schema: {
          name: {
            type: FieldType.STRING,
            name: "name",
            constraints: {
              type: "string",
            },
          },
          description: {
            type: FieldType.STRING,
            name: "description",
            constraints: {
              type: "string",
            },
          },
        },
      },
      ...overrides
    )
  }

  beforeEach(async () => {
    mocks.licenses.useCloudFree()
  })

  const getRowUsage = async () => {
    const { total } = await config.doInContext(undefined, () =>
      quotas.getCurrentUsageValues(QuotaUsageType.STATIC, StaticQuotaName.ROWS)
    )
    return total
  }

  const assertRowUsage = async (expected: number) => {
    const usage = await getRowUsage()
    expect(usage).toBe(expected)
  }

  const defaultRowFields = isInternal
    ? {
        type: "row",
        createdAt: timestamp,
        updatedAt: timestamp,
      }
    : undefined

  beforeAll(async () => {
    table = await config.api.table.save(defaultTable())
  })

  describe("save, load, update", () => {
    it("returns a success message when the row is created", async () => {
      const rowUsage = await getRowUsage()
      const row = await config.api.row.save(table._id!, {
        name: "Test Contact",
      })
      expect(row.name).toEqual("Test Contact")
      expect(row._rev).toBeDefined()
      await assertRowUsage(rowUsage + 1)
    })

    it("Increment row autoId per create row request", async () => {
      const rowUsage = await getRowUsage()

      const newTable = await config.api.table.save(
        saveTableRequest({
          name: "TestTableAuto",
          schema: {
            "Row ID": {
              name: "Row ID",
              type: FieldType.NUMBER,
              subtype: AutoFieldSubType.AUTO_ID,
              icon: "ri-magic-line",
              autocolumn: true,
              constraints: {
                type: "number",
                presence: true,
                numericality: {
                  greaterThanOrEqualTo: "",
                  lessThanOrEqualTo: "",
                },
              },
            },
          },
        })
      )

      let previousId = 0
      for (let i = 0; i < 10; i++) {
        const row = await config.api.row.save(newTable._id!, {})
        expect(row["Row ID"]).toBeGreaterThan(previousId)
        previousId = row["Row ID"]
      }
      await assertRowUsage(rowUsage + 10)
    })

    it("updates a row successfully", async () => {
      const existing = await config.api.row.save(table._id!, {})
      const rowUsage = await getRowUsage()

      const res = await config.api.row.save(table._id!, {
        _id: existing._id,
        _rev: existing._rev,
        name: "Updated Name",
      })

      expect(res.name).toEqual("Updated Name")
      await assertRowUsage(rowUsage)
    })

    it("should load a row", async () => {
      const existing = await config.api.row.save(table._id!, {})

      const res = await config.api.row.get(table._id!, existing._id!)

      expect(res).toEqual({
        ...existing,
        ...defaultRowFields,
      })
    })

    it("should list all rows for given tableId", async () => {
      const table = await config.api.table.save(defaultTable())
      const rows = await Promise.all([
        config.api.row.save(table._id!, {}),
        config.api.row.save(table._id!, {}),
      ])

      const res = await config.api.row.fetch(table._id!)
      expect(res.map(r => r._id)).toEqual(
        expect.arrayContaining(rows.map(r => r._id))
      )
    })

    it("load should return 404 when row does not exist", async () => {
      const table = await config.api.table.save(defaultTable())
      await config.api.row.save(table._id!, {})
      await config.api.row.get(table._id!, "1234567", {
        status: 404,
      })
    })

    isInternal &&
      it("row values are coerced", async () => {
        const str: FieldSchema = {
          type: FieldType.STRING,
          name: "str",
          constraints: { type: "string", presence: false },
        }
        const attachment: FieldSchema = {
          type: FieldType.ATTACHMENT,
          name: "attachment",
          constraints: { type: "array", presence: false },
        }
        const bool: FieldSchema = {
          type: FieldType.BOOLEAN,
          name: "boolean",
          constraints: { type: "boolean", presence: false },
        }
        const number: FieldSchema = {
          type: FieldType.NUMBER,
          name: "str",
          constraints: { type: "number", presence: false },
        }
        const datetime: FieldSchema = {
          type: FieldType.DATETIME,
          name: "datetime",
          constraints: {
            type: "string",
            presence: false,
            datetime: { earliest: "", latest: "" },
          },
        }
        const arrayField: FieldSchema = {
          type: FieldType.ARRAY,
          constraints: {
            type: "array",
            presence: false,
            inclusion: ["One", "Two", "Three"],
          },
          name: "Sample Tags",
          sortable: false,
        }
        const optsField: FieldSchema = {
          name: "Sample Opts",
          type: FieldType.OPTIONS,
          constraints: {
            type: "string",
            presence: false,
            inclusion: ["Alpha", "Beta", "Gamma"],
          },
        }
        const table = await config.api.table.save(
          saveTableRequest({
            name: "TestTable2",
            type: "table",
            schema: {
              name: str,
              stringUndefined: str,
              stringNull: str,
              stringString: str,
              numberEmptyString: number,
              numberNull: number,
              numberUndefined: number,
              numberString: number,
              numberNumber: number,
              datetimeEmptyString: datetime,
              datetimeNull: datetime,
              datetimeUndefined: datetime,
              datetimeString: datetime,
              datetimeDate: datetime,
              boolNull: bool,
              boolEmpty: bool,
              boolUndefined: bool,
              boolString: bool,
              boolBool: bool,
              attachmentNull: attachment,
              attachmentUndefined: attachment,
              attachmentEmpty: attachment,
              attachmentEmptyArrayStr: attachment,
              arrayFieldEmptyArrayStr: arrayField,
              arrayFieldArrayStrKnown: arrayField,
              arrayFieldNull: arrayField,
              arrayFieldUndefined: arrayField,
              optsFieldEmptyStr: optsField,
              optsFieldUndefined: optsField,
              optsFieldNull: optsField,
              optsFieldStrKnown: optsField,
            },
          })
        )

        const datetimeStr = "1984-04-20T00:00:00.000Z"

        const row = await config.api.row.save(table._id!, {
          name: "Test Row",
          stringUndefined: undefined,
          stringNull: null,
          stringString: "i am a string",
          numberEmptyString: "",
          numberNull: null,
          numberUndefined: undefined,
          numberString: "123",
          numberNumber: 123,
          datetimeEmptyString: "",
          datetimeNull: null,
          datetimeUndefined: undefined,
          datetimeString: datetimeStr,
          datetimeDate: new Date(datetimeStr),
          boolNull: null,
          boolEmpty: "",
          boolUndefined: undefined,
          boolString: "true",
          boolBool: true,
          tableId: table._id,
          attachmentNull: null,
          attachmentUndefined: undefined,
          attachmentEmpty: "",
          attachmentEmptyArrayStr: "[]",
          arrayFieldEmptyArrayStr: "[]",
          arrayFieldUndefined: undefined,
          arrayFieldNull: null,
          arrayFieldArrayStrKnown: "['One']",
          optsFieldEmptyStr: "",
          optsFieldUndefined: undefined,
          optsFieldNull: null,
          optsFieldStrKnown: "Alpha",
        })

        expect(row.stringUndefined).toBe(undefined)
        expect(row.stringNull).toBe(null)
        expect(row.stringString).toBe("i am a string")
        expect(row.numberEmptyString).toBe(null)
        expect(row.numberNull).toBe(null)
        expect(row.numberUndefined).toBe(undefined)
        expect(row.numberString).toBe(123)
        expect(row.numberNumber).toBe(123)
        expect(row.datetimeEmptyString).toBe(null)
        expect(row.datetimeNull).toBe(null)
        expect(row.datetimeUndefined).toBe(undefined)
        expect(row.datetimeString).toBe(new Date(datetimeStr).toISOString())
        expect(row.datetimeDate).toBe(new Date(datetimeStr).toISOString())
        expect(row.boolNull).toBe(null)
        expect(row.boolEmpty).toBe(null)
        expect(row.boolUndefined).toBe(undefined)
        expect(row.boolString).toBe(true)
        expect(row.boolBool).toBe(true)
        expect(row.attachmentNull).toEqual([])
        expect(row.attachmentUndefined).toBe(undefined)
        expect(row.attachmentEmpty).toEqual([])
        expect(row.attachmentEmptyArrayStr).toEqual([])
        expect(row.arrayFieldEmptyArrayStr).toEqual([])
        expect(row.arrayFieldNull).toEqual([])
        expect(row.arrayFieldUndefined).toEqual(undefined)
        expect(row.optsFieldEmptyStr).toEqual(null)
        expect(row.optsFieldUndefined).toEqual(undefined)
        expect(row.optsFieldNull).toEqual(null)
        expect(row.arrayFieldArrayStrKnown).toEqual(["One"])
        expect(row.optsFieldStrKnown).toEqual("Alpha")
      })
  })

  describe("view save", () => {
    it("views have extra data trimmed", async () => {
      const table = await config.api.table.save(
        saveTableRequest({
          name: "orders",
          schema: {
            Country: {
              type: FieldType.STRING,
              name: "Country",
            },
            Story: {
              type: FieldType.STRING,
              name: "Story",
            },
          },
        })
      )

      const createViewResponse = await config.api.viewV2.create({
        tableId: table._id!,
        name: uuid.v4(),
        schema: {
          Country: {
            visible: true,
          },
        },
      })

      const createRowResponse = await config.api.row.save(
        createViewResponse.id,
        {
          Country: "Aussy",
          Story: "aaaaa",
        }
      )

      const row = await config.api.row.get(table._id!, createRowResponse._id!)
      expect(row.Story).toBeUndefined()
      expect(row).toEqual({
        ...defaultRowFields,
        Country: "Aussy",
        id: createRowResponse.id,
        _id: createRowResponse._id,
        _rev: createRowResponse._rev,
        tableId: table._id,
      })
    })
  })

  describe("patch", () => {
    let otherTable: Table

    beforeAll(async () => {
      table = await config.api.table.save(defaultTable())
      otherTable = await config.api.table.save(
        defaultTable({
          name: "a",
          schema: {
            relationship: {
              name: "relationship",
              relationshipType: RelationshipType.ONE_TO_MANY,
              type: FieldType.LINK,
              tableId: table._id!,
              fieldName: "relationship",
            },
          },
        })
      )
    })

    it("should update only the fields that are supplied", async () => {
      const existing = await config.api.row.save(table._id!, {})

      const rowUsage = await getRowUsage()

      const row = await config.api.row.patch(table._id!, {
        _id: existing._id!,
        _rev: existing._rev!,
        tableId: table._id!,
        name: "Updated Name",
      })

      expect(row.name).toEqual("Updated Name")
      expect(row.description).toEqual(existing.description)

      const savedRow = await config.api.row.get(table._id!, row._id!)

      expect(savedRow.description).toEqual(existing.description)
      expect(savedRow.name).toEqual("Updated Name")
      await assertRowUsage(rowUsage)
    })

    it("should throw an error when given improper types", async () => {
      const existing = await config.api.row.save(table._id!, {})
      const rowUsage = await getRowUsage()

      await config.api.row.patch(
        table._id!,
        {
          _id: existing._id!,
          _rev: existing._rev!,
          tableId: table._id!,
          name: 1,
        },
        { status: 400 }
      )

      await assertRowUsage(rowUsage)
    })

    it("should not overwrite links if those links are not set", async () => {
      let linkField: FieldSchema = {
        type: FieldType.LINK,
        name: "",
        fieldName: "",
        constraints: {
          type: "array",
          presence: false,
        },
        relationshipType: RelationshipType.ONE_TO_MANY,
        tableId: InternalTable.USER_METADATA,
      }

      let table = await config.api.table.save({
        name: "TestTable",
        type: "table",
        sourceType: TableSourceType.INTERNAL,
        sourceId: INTERNAL_TABLE_SOURCE_ID,
        schema: {
          user1: { ...linkField, name: "user1", fieldName: "user1" },
          user2: { ...linkField, name: "user2", fieldName: "user2" },
        },
      })

      let user1 = await config.createUser()
      let user2 = await config.createUser()

      let row = await config.api.row.save(table._id!, {
        user1: [{ _id: user1._id }],
        user2: [{ _id: user2._id }],
      })

      let getResp = await config.api.row.get(table._id!, row._id!)
      expect(getResp.user1[0]._id).toEqual(user1._id)
      expect(getResp.user2[0]._id).toEqual(user2._id)

      let patchResp = await config.api.row.patch(table._id!, {
        _id: row._id!,
        _rev: row._rev!,
        tableId: table._id!,
        user1: [{ _id: user2._id }],
      })
      expect(patchResp.user1[0]._id).toEqual(user2._id)
      expect(patchResp.user2[0]._id).toEqual(user2._id)

      getResp = await config.api.row.get(table._id!, row._id!)
      expect(getResp.user1[0]._id).toEqual(user2._id)
      expect(getResp.user2[0]._id).toEqual(user2._id)
    })

    it("should be able to update relationships when both columns are same name", async () => {
      let row = await config.api.row.save(table._id!, {
        name: "test",
        description: "test",
      })
      let row2 = await config.api.row.save(otherTable._id!, {
        name: "test",
        description: "test",
        relationship: [row._id],
      })
      row = await config.api.row.get(table._id!, row._id!)
      expect(row.relationship.length).toBe(1)
      const resp = await config.api.row.patch(table._id!, {
        _id: row._id!,
        _rev: row._rev!,
        tableId: row.tableId!,
        name: "test2",
        relationship: [row2._id],
      })
      expect(resp.relationship.length).toBe(1)
    })
  })

  describe("destroy", () => {
    beforeAll(async () => {
      table = await config.api.table.save(defaultTable())
    })

    it("should be able to delete a row", async () => {
      const createdRow = await config.api.row.save(table._id!, {})
      const rowUsage = await getRowUsage()

      const res = await config.api.row.bulkDelete(table._id!, {
        rows: [createdRow],
      })
      expect(res[0]._id).toEqual(createdRow._id)
      await assertRowUsage(rowUsage - 1)
    })

    it("should be able to bulk delete rows, including a row that doesn't exist", async () => {
      const createdRow = await config.api.row.save(table._id!, {})

      const res = await config.api.row.bulkDelete(table._id!, {
        rows: [createdRow, { _id: "9999999" }],
      })

      expect(res[0]._id).toEqual(createdRow._id)
      expect(res.length).toEqual(1)
    })
  })

  describe("validate", () => {
    beforeAll(async () => {
      table = await config.api.table.save(defaultTable())
    })

    it("should return no errors on valid row", async () => {
      const rowUsage = await getRowUsage()

      const res = await config.api.row.validate(table._id!, { name: "ivan" })

      expect(res.valid).toBe(true)
      expect(Object.keys(res.errors)).toEqual([])
      await assertRowUsage(rowUsage)
    })

    it("should errors on invalid row", async () => {
      const rowUsage = await getRowUsage()

      const res = await config.api.row.validate(table._id!, { name: 1 })

      if (isInternal) {
        expect(res.valid).toBe(false)
        expect(Object.keys(res.errors)).toEqual(["name"])
      } else {
        // Validation for external is not implemented, so it will always return valid
        expect(res.valid).toBe(true)
        expect(Object.keys(res.errors)).toEqual([])
      }
      await assertRowUsage(rowUsage)
    })
  })

  describe("bulkDelete", () => {
    beforeAll(async () => {
      table = await config.api.table.save(defaultTable())
    })

    it("should be able to delete a bulk set of rows", async () => {
      const row1 = await config.api.row.save(table._id!, {})
      const row2 = await config.api.row.save(table._id!, {})
      const rowUsage = await getRowUsage()

      const res = await config.api.row.bulkDelete(table._id!, {
        rows: [row1, row2],
      })

      expect(res.length).toEqual(2)
      await config.api.row.get(table._id!, row1._id!, { status: 404 })
      await assertRowUsage(rowUsage - 2)
    })

    it("should be able to delete a variety of row set types", async () => {
      const [row1, row2, row3] = await Promise.all([
        config.api.row.save(table._id!, {}),
        config.api.row.save(table._id!, {}),
        config.api.row.save(table._id!, {}),
      ])
      const rowUsage = await getRowUsage()

      const res = await config.api.row.bulkDelete(table._id!, {
        rows: [row1, row2._id!, { _id: row3._id }],
      })

      expect(res.length).toEqual(3)
      await config.api.row.get(table._id!, row1._id!, { status: 404 })
      await assertRowUsage(rowUsage - 3)
    })

    it("should accept a valid row object and delete the row", async () => {
      const row1 = await config.api.row.save(table._id!, {})
      const rowUsage = await getRowUsage()

      const res = await config.api.row.delete(table._id!, row1 as DeleteRow)

      expect(res.id).toEqual(row1._id)
      await config.api.row.get(table._id!, row1._id!, { status: 404 })
      await assertRowUsage(rowUsage - 1)
    })

    it("Should ignore malformed/invalid delete requests", async () => {
      const rowUsage = await getRowUsage()

      await config.api.row.delete(table._id!, { not: "valid" } as any, {
        status: 400,
        body: {
          message: "Invalid delete rows request",
        },
      })

      await config.api.row.delete(table._id!, { rows: 123 } as any, {
        status: 400,
        body: {
          message: "Invalid delete rows request",
        },
      })

      await config.api.row.delete(table._id!, "invalid" as any, {
        status: 400,
        body: {
          message: "Invalid delete rows request",
        },
      })

      await assertRowUsage(rowUsage)
    })
  })

  // Legacy views are not available for external
  isInternal &&
    describe("fetchView", () => {
      beforeEach(async () => {
        table = await config.api.table.save(defaultTable())
      })

      it("should be able to fetch tables contents via 'view'", async () => {
        const row = await config.api.row.save(table._id!, {})
        const rowUsage = await getRowUsage()

        const rows = await config.api.legacyView.get(table._id!)
        expect(rows.length).toEqual(1)
        expect(rows[0]._id).toEqual(row._id)
        await assertRowUsage(rowUsage)
      })

      it("should throw an error if view doesn't exist", async () => {
        const rowUsage = await getRowUsage()

        await config.api.legacyView.get("derp", undefined, { status: 404 })

        await assertRowUsage(rowUsage)
      })

      it("should be able to run on a view", async () => {
        const view = await config.createLegacyView({
          tableId: table._id!,
          name: "ViewTest",
          filters: [],
          schema: {},
        })
        const row = await config.api.row.save(table._id!, {})
        const rowUsage = await getRowUsage()

        const rows = await config.api.legacyView.get(view.name)
        expect(rows.length).toEqual(1)
        expect(rows[0]._id).toEqual(row._id)

        await assertRowUsage(rowUsage)
      })
    })

  describe("fetchEnrichedRows", () => {
    beforeAll(async () => {
      table = await config.api.table.save(defaultTable())
    })

    it("should allow enriching some linked rows", async () => {
      const { linkedTable, firstRow, secondRow } = await tenancy.doInTenant(
        config.getTenantId(),
        async () => {
          const linkedTable = await config.api.table.save(
            defaultTable({
              schema: {
                link: {
                  name: "link",
                  fieldName: "link",
                  type: FieldType.LINK,
                  relationshipType: RelationshipType.ONE_TO_MANY,
                  tableId: table._id!,
                },
              },
            })
          )
          const firstRow = await config.api.row.save(table._id!, {
            name: "Test Contact",
            description: "original description",
          })
          const secondRow = await config.api.row.save(linkedTable._id!, {
            name: "Test 2",
            description: "og desc",
            link: [{ _id: firstRow._id }],
          })
          return { linkedTable, firstRow, secondRow }
        }
      )
      const rowUsage = await getRowUsage()

      // test basic enrichment
      const resBasic = await config.api.row.get(
        linkedTable._id!,
        secondRow._id!
      )
      expect(resBasic.link.length).toBe(1)
      expect(resBasic.link[0]).toEqual({
        _id: firstRow._id,
        primaryDisplay: firstRow.name,
      })

      // test full enrichment
      const resEnriched = await config.api.row.getEnriched(
        linkedTable._id!,
        secondRow._id!
      )
      expect(resEnriched.link.length).toBe(1)
      expect(resEnriched.link[0]._id).toBe(firstRow._id)
      expect(resEnriched.link[0].name).toBe("Test Contact")
      expect(resEnriched.link[0].description).toBe("original description")
      await assertRowUsage(rowUsage)
    })
  })

  isInternal &&
    describe("attachments", () => {
      beforeAll(async () => {
        table = await config.api.table.save(defaultTable())
      })

      it("should allow enriching attachment rows", async () => {
        const table = await config.api.table.save(
          defaultTable({
            schema: {
              attachment: {
                type: FieldType.ATTACHMENT,
                name: "attachment",
                constraints: { type: "array", presence: false },
              },
            },
          })
        )
        const attachmentId = `${uuid.v4()}.csv`
        const row = await config.api.row.save(table._id!, {
          name: "test",
          description: "test",
          attachment: [
            {
              key: `${config.getAppId()}/attachments/${attachmentId}`,
            },
          ],
          tableId: table._id,
        })
        await config.withEnv({ SELF_HOSTED: "true" }, async () => {
          return context.doInAppContext(config.getAppId(), async () => {
            const enriched = await outputProcessing(table, [row])
            expect((enriched as Row[])[0].attachment[0].url).toBe(
              `/files/signed/prod-budi-app-assets/${config.getProdAppId()}/attachments/${attachmentId}`
            )
          })
        })
      })
    })

  describe("exportData", () => {
    beforeAll(async () => {
      table = await config.api.table.save(defaultTable())
    })

    it("should allow exporting all columns", async () => {
      const existing = await config.api.row.save(table._id!, {})
      const res = await config.api.row.exportRows(table._id!, {
        rows: [existing._id!],
      })
      const results = JSON.parse(res)
      expect(results.length).toEqual(1)
      const row = results[0]

      // Ensure all original columns were exported
      expect(Object.keys(row).length).toBeGreaterThanOrEqual(
        Object.keys(existing).length
      )
      Object.keys(existing).forEach(key => {
        expect(row[key]).toEqual(existing[key])
      })
    })

    it("should allow exporting only certain columns", async () => {
      const existing = await config.api.row.save(table._id!, {})
      const res = await config.api.row.exportRows(table._id!, {
        rows: [existing._id!],
        columns: ["_id"],
      })
      const results = JSON.parse(res)
      expect(results.length).toEqual(1)
      const row = results[0]

      // Ensure only the _id column was exported
      expect(Object.keys(row).length).toEqual(1)
      expect(row._id).toEqual(existing._id)
    })
  })

  describe("view 2.0", () => {
    async function userTable(): Promise<Table> {
      return saveTableRequest({
        name: `users_${uuid.v4()}`,
        type: "table",
        schema: {
          name: {
            type: FieldType.STRING,
            name: "name",
          },
          surname: {
            type: FieldType.STRING,
            name: "surname",
          },
          age: {
            type: FieldType.NUMBER,
            name: "age",
          },
          address: {
            type: FieldType.STRING,
            name: "address",
          },
          jobTitle: {
            type: FieldType.STRING,
            name: "jobTitle",
          },
        },
      })
    }

    const randomRowData = () => ({
      name: generator.first(),
      surname: generator.last(),
      age: generator.age(),
      address: generator.address(),
      jobTitle: generator.word(),
    })

    describe("create", () => {
      it("should persist a new row with only the provided view fields", async () => {
        const table = await config.api.table.save(await userTable())
        const view = await config.api.viewV2.create({
          tableId: table._id!,
          schema: {
            name: { visible: true },
            surname: { visible: true },
            address: { visible: true },
          },
        })

        const data = randomRowData()
        const newRow = await config.api.row.save(view.id, {
          tableId: table!._id,
          _viewId: view.id,
          ...data,
        })

        const row = await config.api.row.get(table._id!, newRow._id!)
        expect(row).toEqual({
          name: data.name,
          surname: data.surname,
          address: data.address,
          tableId: table!._id,
          _id: newRow._id,
          _rev: newRow._rev,
          id: newRow.id,
          ...defaultRowFields,
        })
        expect(row._viewId).toBeUndefined()
        expect(row.age).toBeUndefined()
        expect(row.jobTitle).toBeUndefined()
      })
    })

    describe("patch", () => {
      it("should update only the view fields for a row", async () => {
        const table = await config.api.table.save(await userTable())
        const tableId = table._id!
        const view = await config.api.viewV2.create({
          tableId: tableId,
          schema: {
            name: { visible: true },
            address: { visible: true },
          },
        })

        const newRow = await config.api.row.save(view.id, {
          tableId,
          _viewId: view.id,
          ...randomRowData(),
        })
        const newData = randomRowData()
        await config.api.row.patch(view.id, {
          tableId,
          _viewId: view.id,
          _id: newRow._id!,
          _rev: newRow._rev!,
          ...newData,
        })

        const row = await config.api.row.get(tableId, newRow._id!)
        expect(row).toEqual({
          ...newRow,
          name: newData.name,
          address: newData.address,
          _id: newRow._id,
          _rev: expect.any(String),
          id: newRow.id,
          ...defaultRowFields,
        })
        expect(row._viewId).toBeUndefined()
        expect(row.age).toBeUndefined()
        expect(row.jobTitle).toBeUndefined()
      })
    })

    describe("destroy", () => {
      it("should be able to delete a row", async () => {
        const table = await config.api.table.save(await userTable())
        const tableId = table._id!
        const view = await config.api.viewV2.create({
          tableId: tableId,
          schema: {
            name: { visible: true },
            address: { visible: true },
          },
        })

        const createdRow = await config.api.row.save(table._id!, {})
        const rowUsage = await getRowUsage()

        await config.api.row.bulkDelete(view.id, { rows: [createdRow] })

        await assertRowUsage(rowUsage - 1)

        await config.api.row.get(tableId, createdRow._id!, {
          status: 404,
        })
      })

      it("should be able to delete multiple rows", async () => {
        const table = await config.api.table.save(await userTable())
        const tableId = table._id!
        const view = await config.api.viewV2.create({
          tableId: tableId,
          schema: {
            name: { visible: true },
            address: { visible: true },
          },
        })

        const rows = await Promise.all([
          config.api.row.save(table._id!, {}),
          config.api.row.save(table._id!, {}),
          config.api.row.save(table._id!, {}),
        ])
        const rowUsage = await getRowUsage()

        await config.api.row.bulkDelete(view.id, { rows: [rows[0], rows[2]] })

        await assertRowUsage(rowUsage - 2)

        await config.api.row.get(tableId, rows[0]._id!, {
          status: 404,
        })
        await config.api.row.get(tableId, rows[2]._id!, {
          status: 404,
        })
        await config.api.row.get(tableId, rows[1]._id!, { status: 200 })
      })
    })

    describe("view search", () => {
      let table: Table
      const viewSchema = { age: { visible: true }, name: { visible: true } }

      beforeAll(async () => {
        table = await config.api.table.save(
          saveTableRequest({
            name: `users_${uuid.v4()}`,
            schema: {
              name: {
                type: FieldType.STRING,
                name: "name",
                constraints: { type: "string" },
              },
              age: {
                type: FieldType.NUMBER,
                name: "age",
                constraints: {},
              },
            },
          })
        )
      })

      it("returns empty rows from view when no schema is passed", async () => {
        const rows = await Promise.all(
          Array.from({ length: 10 }, () =>
            config.api.row.save(table._id!, { tableId: table._id })
          )
        )

        const createViewResponse = await config.api.viewV2.create({
          tableId: table._id!,
        })
        const response = await config.api.viewV2.search(createViewResponse.id)

        expect(response.rows).toHaveLength(10)
        expect(response).toEqual({
          rows: expect.arrayContaining(
            rows.map(r => ({
              _viewId: createViewResponse.id,
              tableId: table._id,
              _id: r._id,
              _rev: r._rev,
              ...defaultRowFields,
            }))
          ),
          ...(isInternal
            ? {}
            : {
                hasNextPage: false,
                bookmark: null,
              }),
        })
      })

      it("searching respects the view filters", async () => {
        await Promise.all(
          Array.from({ length: 10 }, () =>
            config.api.row.save(table._id!, {
              tableId: table._id,
              name: generator.name(),
              age: generator.integer({ min: 10, max: 30 }),
            })
          )
        )

        const expectedRows = await Promise.all(
          Array.from({ length: 5 }, () =>
            config.api.row.save(table._id!, {
              tableId: table._id,
              name: generator.name(),
              age: 40,
            })
          )
        )

        const createViewResponse = await config.api.viewV2.create({
          tableId: table._id!,
          query: [
            { operator: SearchQueryOperators.EQUAL, field: "age", value: 40 },
          ],
          schema: viewSchema,
        })

        const response = await config.api.viewV2.search(createViewResponse.id)

        expect(response.rows).toHaveLength(5)
        expect(response).toEqual({
          rows: expect.arrayContaining(
            expectedRows.map(r => ({
              _viewId: createViewResponse.id,
              tableId: table._id,
              name: r.name,
              age: r.age,
              _id: r._id,
              _rev: r._rev,
              ...defaultRowFields,
            }))
          ),
          ...(isInternal
            ? {}
            : {
                hasNextPage: false,
                bookmark: null,
              }),
        })
      })

      const sortTestOptions: [
        {
          field: string
          order?: SortOrder
          type?: SortType
        },
        string[]
      ][] = [
        [
          {
            field: "name",
            order: SortOrder.ASCENDING,
            type: SortType.STRING,
          },
          ["Alice", "Bob", "Charly", "Danny"],
        ],
        [
          {
            field: "name",
          },
          ["Alice", "Bob", "Charly", "Danny"],
        ],
        [
          {
            field: "name",
            order: SortOrder.DESCENDING,
          },
          ["Danny", "Charly", "Bob", "Alice"],
        ],
        [
          {
            field: "name",
            order: SortOrder.DESCENDING,
            type: SortType.STRING,
          },
          ["Danny", "Charly", "Bob", "Alice"],
        ],
        [
          {
            field: "age",
            order: SortOrder.ASCENDING,
            type: SortType.number,
          },
          ["Danny", "Alice", "Charly", "Bob"],
        ],
        [
          {
            field: "age",
            order: SortOrder.ASCENDING,
          },
          ["Danny", "Alice", "Charly", "Bob"],
        ],
        [
          {
            field: "age",
            order: SortOrder.DESCENDING,
          },
          ["Bob", "Charly", "Alice", "Danny"],
        ],
        [
          {
            field: "age",
            order: SortOrder.DESCENDING,
            type: SortType.number,
          },
          ["Bob", "Charly", "Alice", "Danny"],
        ],
      ]

      describe("sorting", () => {
        let table: Table
        beforeAll(async () => {
          table = await config.api.table.save(await userTable())
          const users = [
            { name: "Alice", age: 25 },
            { name: "Bob", age: 30 },
            { name: "Charly", age: 27 },
            { name: "Danny", age: 15 },
          ]
          await Promise.all(
            users.map(u =>
              config.api.row.save(table._id!, {
                tableId: table._id,
                ...u,
              })
            )
          )
        })

        it.each(sortTestOptions)(
          "allow sorting (%s)",
          async (sortParams, expected) => {
            const createViewResponse = await config.api.viewV2.create({
              tableId: table._id!,
              sort: sortParams,
              schema: viewSchema,
            })

            const response = await config.api.viewV2.search(
              createViewResponse.id
            )

            expect(response.rows).toHaveLength(4)
            expect(response.rows).toEqual(
              expected.map(name => expect.objectContaining({ name }))
            )
          }
        )

        it.each(sortTestOptions)(
          "allow override the default view sorting (%s)",
          async (sortParams, expected) => {
            const createViewResponse = await config.api.viewV2.create({
              tableId: table._id!,
              sort: {
                field: "name",
                order: SortOrder.ASCENDING,
                type: SortType.STRING,
              },
              schema: viewSchema,
            })

            const response = await config.api.viewV2.search(
              createViewResponse.id,
              {
                sort: sortParams.field,
                sortOrder: sortParams.order,
                sortType: sortParams.type,
                query: {},
              }
            )

            expect(response.rows).toHaveLength(4)
            expect(response.rows).toEqual(
              expected.map(name => expect.objectContaining({ name }))
            )
          }
        )
      })

      it("when schema is defined, defined columns and row attributes are returned", async () => {
        const table = await config.api.table.save(await userTable())
        const rows = await Promise.all(
          Array.from({ length: 10 }, () =>
            config.api.row.save(table._id!, {
              tableId: table._id,
              name: generator.name(),
              age: generator.age(),
            })
          )
        )

        const view = await config.api.viewV2.create({
          tableId: table._id!,
          schema: { name: { visible: true } },
        })
        const response = await config.api.viewV2.search(view.id)

        expect(response.rows).toHaveLength(10)
        expect(response.rows).toEqual(
          expect.arrayContaining(
            rows.map(r => ({
              ...(isInternal
                ? expectAnyInternalColsAttributes
                : expectAnyExternalColsAttributes),
              _viewId: view.id,
              name: r.name,
            }))
          )
        )
      })

      it("views without data can be returned", async () => {
        const table = await config.api.table.save(await userTable())
        const createViewResponse = await config.api.viewV2.create({
          tableId: table._id!,
        })
        const response = await config.api.viewV2.search(createViewResponse.id)
        expect(response.rows).toHaveLength(0)
      })

      it("respects the limit parameter", async () => {
        const table = await config.api.table.save(await userTable())
        await Promise.all(
          Array.from({ length: 10 }, () => config.api.row.save(table._id!, {}))
        )

        const limit = generator.integer({ min: 1, max: 8 })

        const createViewResponse = await config.api.viewV2.create({
          tableId: table._id!,
        })
        const response = await config.api.viewV2.search(createViewResponse.id, {
          limit,
          query: {},
        })

        expect(response.rows).toHaveLength(limit)
      })

      it("can handle pagination", async () => {
        const table = await config.api.table.save(await userTable())
        await Promise.all(
          Array.from({ length: 10 }, () => config.api.row.save(table._id!, {}))
        )
        const view = await config.api.viewV2.create({
          tableId: table._id!,
        })
        const rows = (await config.api.viewV2.search(view.id)).rows

        const page1 = await config.api.viewV2.search(view.id, {
          paginate: true,
          limit: 4,
          query: {},
        })
        expect(page1).toEqual({
          rows: expect.arrayContaining(rows.slice(0, 4)),
          totalRows: isInternal ? 10 : undefined,
          hasNextPage: true,
          bookmark: expect.anything(),
        })

        const page2 = await config.api.viewV2.search(view.id, {
          paginate: true,
          limit: 4,
          bookmark: page1.bookmark,

          query: {},
        })
        expect(page2).toEqual({
          rows: expect.arrayContaining(rows.slice(4, 8)),
          totalRows: isInternal ? 10 : undefined,
          hasNextPage: true,
          bookmark: expect.anything(),
        })

        const page3 = await config.api.viewV2.search(view.id, {
          paginate: true,
          limit: 4,
          bookmark: page2.bookmark,
          query: {},
        })
        expect(page3).toEqual({
          rows: expect.arrayContaining(rows.slice(8)),
          totalRows: isInternal ? 10 : undefined,
          hasNextPage: false,
          bookmark: expect.anything(),
        })
      })

      isInternal &&
        it("doesn't allow creating in user table", async () => {
          const userTableId = InternalTable.USER_METADATA
          const response = await config.api.row.save(
            userTableId,
            {
              tableId: userTableId,
              firstName: "Joe",
              lastName: "Joe",
              email: "joe@joe.com",
              roles: {},
            },
            { status: 400 }
          )
          expect(response.message).toBe("Cannot create new user entry.")
        })

      describe("permissions", () => {
        let table: Table
        let view: ViewV2

        beforeAll(async () => {
          table = await config.api.table.save(await userTable())
          await Promise.all(
            Array.from({ length: 10 }, () =>
              config.api.row.save(table._id!, {})
            )
          )

          view = await config.api.viewV2.create({
            tableId: table._id!,
          })
        })

        beforeEach(() => {
          mocks.licenses.useViewPermissions()
        })

        it("does not allow public users to fetch by default", async () => {
          await config.publish()
          await config.api.viewV2.publicSearch(view.id, undefined, {
            status: 403,
          })
        })

        it("allow public users to fetch when permissions are explicit", async () => {
          await config.api.permission.add({
            roleId: roles.BUILTIN_ROLE_IDS.PUBLIC,
            level: PermissionLevel.READ,
            resourceId: view.id,
          })
          await config.publish()

          const response = await config.api.viewV2.publicSearch(view.id)

          expect(response.rows).toHaveLength(10)
        })

        it("allow public users to fetch when permissions are inherited", async () => {
          await config.api.permission.add({
            roleId: roles.BUILTIN_ROLE_IDS.PUBLIC,
            level: PermissionLevel.READ,
            resourceId: table._id!,
          })
          await config.publish()

          const response = await config.api.viewV2.publicSearch(view.id)

          expect(response.rows).toHaveLength(10)
        })

        it("respects inherited permissions, not allowing not public views from public tables", async () => {
          await config.api.permission.add({
            roleId: roles.BUILTIN_ROLE_IDS.PUBLIC,
            level: PermissionLevel.READ,
            resourceId: table._id!,
          })
          await config.api.permission.add({
            roleId: roles.BUILTIN_ROLE_IDS.POWER,
            level: PermissionLevel.READ,
            resourceId: view.id,
          })
          await config.publish()

          await config.api.viewV2.publicSearch(view.id, undefined, {
            status: 403,
          })
        })
      })
    })
  })

  let o2mTable: Table
  let m2mTable: Table
  beforeAll(async () => {
    o2mTable = await config.api.table.save(defaultTable({ name: "o2m" }))
    m2mTable = await config.api.table.save(defaultTable({ name: "m2m" }))
  })

  describe.each([
    [
      "relationship fields",
      (): Record<string, FieldSchema> => ({
        user: {
          name: "user",
          relationshipType: RelationshipType.ONE_TO_MANY,
          type: FieldType.LINK,
          tableId: o2mTable._id!,
          fieldName: "fk_o2m",
        },
        users: {
          name: "users",
          relationshipType: RelationshipType.MANY_TO_MANY,
          type: FieldType.LINK,
          tableId: m2mTable._id!,
          fieldName: "fk_m2m",
        },
      }),
      (tableId: string) =>
        config.api.row.save(tableId, {
          name: uuid.v4(),
          description: generator.paragraph(),
          tableId,
        }),
      (row: Row) => ({
        _id: row._id,
        primaryDisplay: row.name,
      }),
    ],
    [
      "bb reference fields",
      (): Record<string, FieldSchema> => ({
        user: {
          name: "user",
          type: FieldType.BB_REFERENCE,
          subtype: FieldTypeSubtypes.BB_REFERENCE.USER,
        },
        users: {
          name: "users",
          type: FieldType.BB_REFERENCE,
          subtype: FieldTypeSubtypes.BB_REFERENCE.USERS,
        },
      }),
      () => config.createUser(),
      (row: Row) => ({
        _id: row._id,
        primaryDisplay: row.email,
        email: row.email,
        firstName: row.firstName,
        lastName: row.lastName,
      }),
    ],
  ])("links - %s", (__, relSchema, dataGenerator, resultMapper) => {
    let tableId: string
    let o2mData: Row[]
    let m2mData: Row[]

    beforeAll(async () => {
      const table = await config.api.table.save(
        defaultTable({ schema: relSchema() })
      )
      tableId = table._id!

      o2mData = [
        await dataGenerator(o2mTable._id!),
        await dataGenerator(o2mTable._id!),
        await dataGenerator(o2mTable._id!),
        await dataGenerator(o2mTable._id!),
      ]

      m2mData = [
        await dataGenerator(m2mTable._id!),
        await dataGenerator(m2mTable._id!),
        await dataGenerator(m2mTable._id!),
        await dataGenerator(m2mTable._id!),
      ]
    })

    it("can save a row when relationship fields are empty", async () => {
      const row = await config.api.row.save(tableId, {
        name: "foo",
        description: "bar",
      })

      expect(row).toEqual({
        _id: expect.any(String),
        _rev: expect.any(String),
        id: isInternal ? undefined : expect.any(Number),
        type: isInternal ? "row" : undefined,
        name: "foo",
        description: "bar",
        tableId,
      })
    })

    it("can save a row with a single relationship field", async () => {
      const user = _.sample(o2mData)!
      const row = await config.api.row.save(tableId, {
        name: "foo",
        description: "bar",
        user: [user],
      })

      expect(row).toEqual({
        name: "foo",
        description: "bar",
        tableId,
        user: [user].map(u => resultMapper(u)),
        _id: expect.any(String),
        _rev: expect.any(String),
        id: isInternal ? undefined : expect.any(Number),
        type: isInternal ? "row" : undefined,
        [`fk_${o2mTable.name}_fk_o2m`]: isInternal ? undefined : user.id,
      })
    })

    it("can save a row with a multiple relationship field", async () => {
      const selectedUsers = _.sampleSize(m2mData, 2)
      const row = await config.api.row.save(tableId, {
        name: "foo",
        description: "bar",
        users: selectedUsers,
      })

      expect(row).toEqual({
        name: "foo",
        description: "bar",
        tableId,
        users: expect.arrayContaining(selectedUsers.map(u => resultMapper(u))),
        _id: expect.any(String),
        _rev: expect.any(String),
        id: isInternal ? undefined : expect.any(Number),
        type: isInternal ? "row" : undefined,
      })
    })

    it("can retrieve rows with no populated relationships", async () => {
      const row = await config.api.row.save(tableId, {
        name: "foo",
        description: "bar",
      })

      const retrieved = await config.api.row.get(tableId, row._id!)
      expect(retrieved).toEqual({
        name: "foo",
        description: "bar",
        tableId,
        user: undefined,
        users: undefined,
        _id: row._id,
        _rev: expect.any(String),
        id: isInternal ? undefined : expect.any(Number),
        ...defaultRowFields,
      })
    })

    it("can retrieve rows with populated relationships", async () => {
      const user1 = _.sample(o2mData)!
      const [user2, user3] = _.sampleSize(m2mData, 2)

      const row = await config.api.row.save(tableId, {
        name: "foo",
        description: "bar",
        users: [user2, user3],
        user: [user1],
      })

      const retrieved = await config.api.row.get(tableId, row._id!)
      expect(retrieved).toEqual({
        name: "foo",
        description: "bar",
        tableId,
        user: expect.arrayContaining([user1].map(u => resultMapper(u))),
        users: expect.arrayContaining([user2, user3].map(u => resultMapper(u))),
        _id: row._id,
        _rev: expect.any(String),
        id: isInternal ? undefined : expect.any(Number),
        [`fk_${o2mTable.name}_fk_o2m`]: isInternal ? undefined : user1.id,
        ...defaultRowFields,
      })
    })

    it("can update an existing populated row", async () => {
      const user = _.sample(o2mData)!
      const [users1, users2, users3] = _.sampleSize(m2mData, 3)

      const row = await config.api.row.save(tableId, {
        name: "foo",
        description: "bar",
        users: [users1, users2],
      })

      const updatedRow = await config.api.row.save(tableId, {
        ...row,
        user: [user],
        users: [users3, users1],
      })
      expect(updatedRow).toEqual({
        name: "foo",
        description: "bar",
        tableId,
        user: expect.arrayContaining([user].map(u => resultMapper(u))),
        users: expect.arrayContaining(
          [users3, users1].map(u => resultMapper(u))
        ),
        _id: row._id,
        _rev: expect.any(String),
        id: isInternal ? undefined : expect.any(Number),
        type: isInternal ? "row" : undefined,
        [`fk_${o2mTable.name}_fk_o2m`]: isInternal ? undefined : user.id,
      })
    })

    it("can wipe an existing populated relationships in row", async () => {
      const [user1, user2] = _.sampleSize(m2mData, 2)
      const row = await config.api.row.save(tableId, {
        name: "foo",
        description: "bar",
        users: [user1, user2],
      })

      const updatedRow = await config.api.row.save(tableId, {
        ...row,
        user: null,
        users: null,
      })
      expect(updatedRow).toEqual({
        name: "foo",
        description: "bar",
        tableId,
        _id: row._id,
        _rev: expect.any(String),
        id: isInternal ? undefined : expect.any(Number),
        type: isInternal ? "row" : undefined,
      })
    })

    it("fetch all will populate the relationships", async () => {
      const [user1] = _.sampleSize(o2mData, 1)
      const [users1, users2, users3] = _.sampleSize(m2mData, 3)

      const rows = [
        {
          name: generator.name(),
          description: generator.name(),
          users: [users1, users2],
        },
        {
          name: generator.name(),
          description: generator.name(),
          user: [user1],
          users: [users1, users3],
        },
        {
          name: generator.name(),
          description: generator.name(),
          users: [users3],
        },
      ]

      await config.api.row.save(tableId, rows[0])
      await config.api.row.save(tableId, rows[1])
      await config.api.row.save(tableId, rows[2])

      const res = await config.api.row.fetch(tableId)

      expect(res).toEqual(
        expect.arrayContaining(
          rows.map(r => ({
            name: r.name,
            description: r.description,
            tableId,
            user: r.user?.map(u => resultMapper(u)),
            users: r.users?.length
              ? expect.arrayContaining(r.users?.map(u => resultMapper(u)))
              : undefined,
            _id: expect.any(String),
            _rev: expect.any(String),
            id: isInternal ? undefined : expect.any(Number),
            [`fk_${o2mTable.name}_fk_o2m`]:
              isInternal || !r.user?.length ? undefined : r.user[0].id,
            ...defaultRowFields,
          }))
        )
      )
    })

    it("search all will populate the relationships", async () => {
      const [user1] = _.sampleSize(o2mData, 1)
      const [users1, users2, users3] = _.sampleSize(m2mData, 3)

      const rows = [
        {
          name: generator.name(),
          description: generator.name(),
          users: [users1, users2],
        },
        {
          name: generator.name(),
          description: generator.name(),
          user: [user1],
          users: [users1, users3],
        },
        {
          name: generator.name(),
          description: generator.name(),
          users: [users3],
        },
      ]

      await config.api.row.save(tableId, rows[0])
      await config.api.row.save(tableId, rows[1])
      await config.api.row.save(tableId, rows[2])

      const res = await config.api.row.search(tableId)

      expect(res).toEqual({
        rows: expect.arrayContaining(
          rows.map(r => ({
            name: r.name,
            description: r.description,
            tableId,
            user: r.user?.map(u => resultMapper(u)),
            users: r.users?.length
              ? expect.arrayContaining(r.users?.map(u => resultMapper(u)))
              : undefined,
            _id: expect.any(String),
            _rev: expect.any(String),
            id: isInternal ? undefined : expect.any(Number),
            [`fk_${o2mTable.name}_fk_o2m`]:
              isInternal || !r.user?.length ? undefined : r.user[0].id,
            ...defaultRowFields,
          }))
        ),
        ...(isInternal
          ? {}
          : {
              hasNextPage: false,
              bookmark: null,
            }),
      })
    })
  })

  describe("Formula fields", () => {
    let table: Table
    let otherTable: Table
    let relatedRow: Row

    beforeAll(async () => {
      otherTable = await config.api.table.save(defaultTable())
      table = await config.api.table.save(
        saveTableRequest({
          name: "b",
          schema: {
            links: {
              name: "links",
              fieldName: "links",
              type: FieldType.LINK,
              tableId: otherTable._id!,
              relationshipType: RelationshipType.ONE_TO_MANY,
            },
            formula: {
              name: "formula",
              type: FieldType.FORMULA,
              formula: "{{ links.0.name }}",
              formulaType: FormulaType.DYNAMIC,
            },
          },
        })
      )

      relatedRow = await config.api.row.save(otherTable._id!, {
        name: generator.word(),
        description: generator.paragraph(),
      })
      await config.api.row.save(table._id!, {
        name: generator.word(),
        description: generator.paragraph(),
        tableId: table._id!,
        links: [relatedRow._id],
      })
    })

    it("should be able to search for rows containing formulas", async () => {
      const { rows } = await config.api.row.search(table._id!)
      expect(rows.length).toBe(1)
      expect(rows[0].links.length).toBe(1)
      const row = rows[0]
      expect(row.formula).toBe(relatedRow.name)
    })
  })

  describe("Formula JS protection", () => {
    it("should time out JS execution if a single cell takes too long", async () => {
      await config.withEnv({ JS_PER_INVOCATION_TIMEOUT_MS: 20 }, async () => {
        const js = Buffer.from(
          `
              let i = 0;
              while (true) {
                i++;
              }
              return i;
            `
        ).toString("base64")

        const table = await config.api.table.save(
          saveTableRequest({
            schema: {
              text: {
                name: "text",
                type: FieldType.STRING,
              },
              formula: {
                name: "formula",
                type: FieldType.FORMULA,
                formula: `{{ js "${js}"}}`,
                formulaType: FormulaType.DYNAMIC,
              },
            },
          })
        )

        await config.api.row.save(table._id!, { text: "foo" })
        const { rows } = await config.api.row.search(table._id!)
        expect(rows).toHaveLength(1)
        const row = rows[0]
        expect(row.text).toBe("foo")
        expect(row.formula).toBe("Timed out while executing JS")
      })
    })

    it("should time out JS execution if a multiple cells take too long", async () => {
      await config.withEnv(
        {
          JS_PER_INVOCATION_TIMEOUT_MS: 20,
          JS_PER_REQUEST_TIMEOUT_MS: 40,
        },
        async () => {
          const js = Buffer.from(
            `
              let i = 0;
              while (true) {
                i++;
              }
              return i;
            `
          ).toString("base64")

          const table = await config.api.table.save(
            saveTableRequest({
              name: "table",
              schema: {
                text: {
                  name: "text",
                  type: FieldType.STRING,
                },
                formula: {
                  name: "formula",
                  type: FieldType.FORMULA,
                  formula: `{{ js "${js}"}}`,
                  formulaType: FormulaType.DYNAMIC,
                },
              },
            })
          )

          for (let i = 0; i < 10; i++) {
            await config.api.row.save(table._id!, { text: "foo" })
          }

          // Run this test 3 times to make sure that there's no cross-request
          // pollution of the execution time tracking.
          for (let reqs = 0; reqs < 3; reqs++) {
            const { rows } = await config.api.row.search(table._id!)
            expect(rows).toHaveLength(10)

            let i = 0
            for (; i < 10; i++) {
              const row = rows[i]
              if (row.formula !== "Timed out while executing JS") {
                break
              }
            }

            // Given the execution times are not deterministic, we can't be sure
            // of the exact number of rows that were executed before the timeout
            // but it should absolutely be at least 1.
            expect(i).toBeGreaterThan(0)
            expect(i).toBeLessThan(5)

            for (; i < 10; i++) {
              const row = rows[i]
              expect(row.text).toBe("foo")
              expect(row.formula).toBe("Request JS execution limit hit")
            }
          }
        }
      )
    })

    it("should not carry over context between formulas", async () => {
      const js = Buffer.from(`return $("[text]");`).toString("base64")
      const table = await config.api.table.save(
        saveTableRequest({
          schema: {
            text: {
              name: "text",
              type: FieldType.STRING,
            },
            formula: {
              name: "formula",
              type: FieldType.FORMULA,
              formula: `{{ js "${js}"}}`,
              formulaType: FormulaType.DYNAMIC,
            },
          },
        })
      )

      for (let i = 0; i < 10; i++) {
        await config.api.row.save(table._id!, { text: `foo${i}` })
      }

      const { rows } = await config.api.row.search(table._id!)
      expect(rows).toHaveLength(10)

      const formulaValues = rows.map(r => r.formula)
      expect(formulaValues).toEqual(
        expect.arrayContaining([
          "foo0",
          "foo1",
          "foo2",
          "foo3",
          "foo4",
          "foo5",
          "foo6",
          "foo7",
          "foo8",
          "foo9",
        ])
      )
    })
  })
})
