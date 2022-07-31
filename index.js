require('dotenv').config();
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const argv = yargs(hideBin(process.argv)).option('contract', {string: true}).argv;
const ethers = require('ethers');
const fs = require('fs');

/**
 * Required arguments
 **/
const TOKEN_CONTRACT_ADDRESS = argv.contract;
const ERC_STANDARD = parseInt(argv.erc, 10);
const BLOCK_FROM = parseInt(argv.from, 10);
const BLOCK_TO = parseInt(argv.to, 10);

/**
Example: node index.js --contract 0x0 --erc 721 --from 1000 --to 2000
**/

// Validation
if (!TOKEN_CONTRACT_ADDRESS || TOKEN_CONTRACT_ADDRESS.length !== 42) {
  console.error("Invalid Token Contract Address");
  process.exit();
}

let ABI, TRANSFER_EVENT;
if (!ERC_STANDARD || [20, 721, 1155].indexOf(ERC_STANDARD) === -1) {
  console.error("Invalid Token ERC Standard");
  process.exit();
} else if (ERC_STANDARD === 20) {
  ABI = JSON.parse(fs.readFileSync(__dirname + '/config/abi/erc20.json', 'utf8'));
  console.error("Not currently supported");
  process.exit();  
} else if (ERC_STANDARD === 721) {
  ABI = JSON.parse(fs.readFileSync(__dirname + '/config/abi/erc721.json', 'utf8'));
} else if (ERC_STANDARD === 1155) {
  ABI = JSON.parse(fs.readFileSync(__dirname + '/config/abi/erc1155.json', 'utf8'));
}

const BLOCK_SIZE = 250;

async function main() {

  // Setup
  const provider = new ethers.providers.JsonRpcProvider(process.env.ETHEREUM_NODE_ENDPOINT);
  const tokenContract = new ethers.Contract(TOKEN_CONTRACT_ADDRESS, ABI, provider);

  // Look in batches of N blocks
  let fromBlock = BLOCK_FROM;
  let toBlock = Math.min(BLOCK_TO, BLOCK_FROM + BLOCK_SIZE);

  // Store all records
  let transferRecords = [];

  // Now analyze
  while (toBlock < BLOCK_TO) {

    let promises = [];
    let BATCH_NUMBER = 10;

    for (let batchIdx = 0; batchIdx <= BATCH_NUMBER; batchIdx++) {

      // Get event set
      promises.push(getEventsInRange(tokenContract, fromBlock, toBlock));

      // Go to next set
      fromBlock = toBlock + 1; // To Block is inclusive, so bump to next
      toBlock = Math.min(BLOCK_TO, toBlock + BLOCK_SIZE);

      if (BLOCK_TO === toBlock) {
        break;
      }
    }

    transferRecords = transferRecords.concat(...(await Promise.all(promises)));
  }

  // Sort them
  transferRecords.sort((a, b) => {
    if (a.blockNumber < b.blockNumber) {
      return -1;
    } else if (a.blockNumber > b.blockNumber) {
      return 1;
    }

    if (a.transactionIndex < b.transactionIndex) {
      return -1;
    } else if (a.transactionIndex > b.transactionIndex) {
      return 1;
    }

    if (a.logIndex < b.logIndex) {
      return -1;
    } else if (a.logIndex > b.logIndex) {
      return 1;
    }

    throw `This should never, ever happen`;
  })

  // Now, keep track of all owners and current holdings
  let ownerRecords = {};

  for (let transfer of transferRecords) {
    if (!ownerRecords.hasOwnProperty(transfer.from)) {
      ownerRecords[transfer.from] = {};
    }

    if (!ownerRecords[transfer.from].hasOwnProperty(transfer.id)) {
      ownerRecords[transfer.from][transfer.id] = -transfer.amount;
    } else {
      ownerRecords[transfer.from][transfer.id] -= transfer.amount;
    }

    if (!ownerRecords.hasOwnProperty(transfer.to)) {
      ownerRecords[transfer.to] = {};
    }

    if (!ownerRecords[transfer.to].hasOwnProperty(transfer.id)) {
      ownerRecords[transfer.to][transfer.id] = transfer.amount;
    } else {
      ownerRecords[transfer.to][transfer.id] += transfer.amount;
    }
  }

  console.log(ownerRecords);
  fs.writeFileSync(__dirname + '/output/' + TOKEN_CONTRACT_ADDRESS + '-' + BLOCK_TO + '.json', JSON.stringify(ownerRecords, null, 4));
  console.log("done");
}

async function getEventsInRange(tokenContract, fromBlock, toBlock) {

  // Keep track of local transfer records
  let transferRecords = [];

  if (ERC_STANDARD === 721) {

    // Create the transfer filter
    let eventFilter = tokenContract.filters.Transfer();

    // Get the single transfer events
    let events = await tokenContract.queryFilter(eventFilter, fromBlock, toBlock);

    // Store the records
    for (let event of events) {
      transferRecords.push({
        blockNumber : event.blockNumber,
        transactionIndex : event.transactionIndex,
        logIndex : event.logIndex,
        from : event.args.from,
        to : event.args.to,
        id : event.args.tokenId.toString(),
        amount : 1
      });
    }

    console.log("Found", events.length, "transfer events from block", fromBlock, "to", toBlock);

  } else if (ERC_STANDARD === 1155) {

    // Create the transfer filter
    let tsEventFilter = tokenContract.filters.TransferSingle();
    let tbEventFilter = tokenContract.filters.TransferBatch();

    // Get the single transfer events
    let tsEvents = await tokenContract.queryFilter(tsEventFilter, fromBlock, toBlock);

    // Store the records
    for (let event of tsEvents) {
      transferRecords.push({
        blockNumber : event.blockNumber,
        transactionIndex : event.transactionIndex,
        logIndex : event.logIndex,
        from : event.args._from,
        to : event.args._to,
        id : event.args._id.toString(),
        amount : event.args._amount.toNumber(),
      });
    }

    // Get the batch transfer events
    let tbEvents = await tokenContract.queryFilter(tbEventFilter, fromBlock, toBlock);

    // Store the records
    for (let event of tbEvents) {
      for (let idx in event._ids) {
        transferRecords.push({
          blockNumber : event.blockNumber,
          transactionIndex : event.transactionIndex,
          logIndex : event.logIndex,
          from : event.args._from,
          to : event.args._to,
          id : event.args._ids[idx].toString(),
          amount : event.args._amounts[idx].toNumber(),
        });
      }
    }

    console.log("Found", tsEvents.length, "single transfer events and", tbEvents.length, "batch transfer events from block", fromBlock, "to", toBlock);

  }

  return transferRecords;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
