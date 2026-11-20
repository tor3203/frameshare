import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

// Local preview/test adapter; hosted schema migrations are applied by Sites.
export function localDatabase(filename=':memory:'){
 const db=new DatabaseSync(filename),directory=fileURLToPath(new URL('../drizzle/',import.meta.url));
 db.exec('CREATE TABLE IF NOT EXISTS local_migrations (name TEXT PRIMARY KEY)');
 for(const name of readdirSync(directory).filter(n=>n.endsWith('.sql')).sort()){
  if(db.prepare('SELECT name FROM local_migrations WHERE name=?').get(name))continue;
  db.exec(readFileSync(directory+'/'+name,'utf8'));db.prepare('INSERT INTO local_migrations VALUES (?)').run(name);
 }
 return {prepare(sql){let args=[];const statement=db.prepare(sql);const wrapper={bind(...values){args=values;return wrapper},async first(){return statement.get(...args)||null},async all(){return {results:statement.all(...args)}},async run(){return statement.run(...args)}};return wrapper},close(){db.close()}};
}
