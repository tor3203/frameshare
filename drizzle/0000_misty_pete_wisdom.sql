CREATE TABLE `collaboration_gestures` (
	`key` text PRIMARY KEY NOT NULL,
	`room` text NOT NULL,
	`value` text NOT NULL,
	`sequence` integer NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `collaboration_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL
);
