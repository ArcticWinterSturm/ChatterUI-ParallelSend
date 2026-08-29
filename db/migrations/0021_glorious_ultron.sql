ALTER TABLE `chat_attachment` ADD `sha256` text;--> statement-breakpoint
ALTER TABLE `chat_attachment` ADD `width` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `chat_attachment` ADD `height` integer DEFAULT 0 NOT NULL;