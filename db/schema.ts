import {sqliteTable,text,integer,index} from 'drizzle-orm/sqlite-core';
export const collaborationState=sqliteTable('collaboration_state',{
 key:text('key').primaryKey(),value:text('value').notNull(),version:integer('version').notNull().default(0),
});
export const collaborationGestures=sqliteTable('collaboration_gestures',{
 key:text('key').primaryKey(),room:text('room').notNull(),value:text('value').notNull(),sequence:integer('sequence').notNull(),expires:integer('expires').notNull(),
},table=>[index('gestures_room_expiry').on(table.room,table.expires)]);
