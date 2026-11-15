import { Param, sql, type DriverValueEncoder } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

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

export function columnPlaceholder(name: string, column: DriverValueEncoder<unknown, unknown>): Param {
  return new Param(sql.placeholder(name), column);
}
