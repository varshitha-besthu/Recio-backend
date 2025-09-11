/*
  Warnings:

  - A unique constraint covering the columns `[name,createdById]` on the table `Room` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "public"."Room_name_key";

-- CreateIndex
CREATE UNIQUE INDEX "Room_name_createdById_key" ON "public"."Room"("name", "createdById");
