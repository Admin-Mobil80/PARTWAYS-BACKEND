import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, QueryCommand, BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';

// Single-table layout: PK = NS#<namespace>, SK = <type>#<id>, item JSON in `doc`.
// A query on PK + SK prefix lists one type within one workspace.

export function createDynamoStore(tableName) {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const key = (ns, type, id) => ({ PK: `NS#${ns}`, SK: `${type}#${id}` });

  async function list(ns, type) {
    const out = [];
    let ExclusiveStartKey;
    do {
      const res = await ddb.send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': `NS#${ns}`, ':sk': `${type}#` },
        ExclusiveStartKey,
      }));
      for (const i of res.Items || []) out.push(i.doc);
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return out;
  }

  async function batch(requests) {
    for (let i = 0; i < requests.length; i += 25) {
      let RequestItems = { [tableName]: requests.slice(i, i + 25) };
      for (let attempt = 0; attempt < 6 && RequestItems[tableName]?.length; attempt++) {
        const res = await ddb.send(new BatchWriteCommand({ RequestItems }));
        RequestItems = res.UnprocessedItems || {};
        if (RequestItems[tableName]?.length) await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
      }
    }
  }

  return {
    async get(ns, type, id) {
      const res = await ddb.send(new GetCommand({ TableName: tableName, Key: key(ns, type, id) }));
      return res.Item?.doc ?? null;
    },
    async put(ns, type, item) {
      const extra = item.expiresAt && ['otp', 'signup'].includes(type) ? { ttl: Math.floor(item.expiresAt / 1000) } : {};
      await ddb.send(new PutCommand({ TableName: tableName, Item: { ...key(ns, type, item.id), doc: item, ...extra } }));
      return item;
    },
    async delete(ns, type, id) {
      await ddb.send(new DeleteCommand({ TableName: tableName, Key: key(ns, type, id) }));
    },
    list,
    async putMany(ns, type, items) {
      await batch(items.map((doc) => ({ PutRequest: { Item: { ...key(ns, type, doc.id), doc } } })));
    },
    async clear(ns, types) {
      for (const t of types) {
        const items = await list(ns, t);
        await batch(items.map((d) => ({ DeleteRequest: { Key: key(ns, t, d.id) } })));
      }
    },
  };
}
