export function redeployCommand(serviceNames?: string[]) {
  console.log(
    `Luma redeploy command for services: ${serviceNames?.join(", ") || "all"}`
  );
}
