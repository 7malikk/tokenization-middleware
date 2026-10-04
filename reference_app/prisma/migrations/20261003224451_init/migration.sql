-- CreateTable
CREATE TABLE "customer" (
    "id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "bvn_token" CHAR(32) NOT NULL,

    CONSTRAINT "customer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_bvn_token_key" ON "customer"("bvn_token");
