import { Param, sql, type DriverValueEncoder } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

// A prepared statement runs on the client that prepared it, so each client keeps its own.
export function preparedStatements<Shape extends string, Statement>(prepare: (db: Db, shape: Shape) => Statement) {
  const statements = new WeakMap<Db, Map<Shape, Statement>>();
  return (db: Db, shape: Shape): Statement => {
    let shapes = statements.get(db);
    if (!shapes) statements.set(db, shapes = new Map());
    let statement = shapes.get(shape);
    if (!statement) shapes.set(shape, statement = prepare(db, shape));
    return statement;
  };
}

// A bare placeholder skips the column's encoding. This one encodes its value as the column encodes a bound value.
export function columnPlaceholder(name: string, column: DriverValueEncoder<unknown, unknown>): Param {
  return new Param(sql.placeholder(name), column);
}
