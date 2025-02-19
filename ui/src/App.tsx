import React, {useEffect, useState, useRef} from 'react';
import {createDockerDesktopClient} from '@docker/extension-api-client';
import {Divider, FormLabel, Link, Stack, Typography, useTheme} from '@mui/material';
import QuestionAnswerIcon from '@mui/icons-material/QuestionAnswer';
import FormGroup from '@mui/material/FormGroup';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import FormControl from '@mui/material/FormControl';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Box from '@mui/material/Box';
import {blue, teal, deepPurple, lime, blueGrey} from '@mui/material/colors';

import Device from "./classes/Device";
import RawContainerStats from "./interfaces/RawContainerStats";
import ContainerStats from "./classes/ContainerStats";
import Container from "./classes/Container";
import Stats from "./classes/Stats";
import ContainersCollection from "./classes/ContainersCollection";
import StatsStack from "./classes/StatsStack";
import ChartsMaker from "./ChartsMaker";
import ChartItem from "./classes/ChartItem";
import ChartData from "./classes/ChartData";

const devices: Device[] = [
  new Device('CPU', 'cpu', '%', blue[400]),
  new Device('Memory', 'memory', 'MB', teal[400]),
  new Device('Disk', 'disk', 'MB', deepPurple[300]),
  new Device('Network', 'network', 'MB', lime[800]),
];

const graphMergeOptions = [
  {name: 'Overview', value: 'overview'},
  {name: 'Combine', value: 'combine'},
  {name: 'Split', value: 'split'},
];

const MAX_CHARTS: number = 12;
const MAX_CONSECUTIVE_FAILED_READS: number = 20;
const MAX_STACK_ITEMS: number = 60;

// Note: This line relies on Docker Desktop's presence as a host application.
// If you're running this React app in a browser, it won't work properly.
const client = createDockerDesktopClient();

function useDockerDesktopClient() {
  return client;
}

export function App() {
  const [runningContainers, setRunningContainers] = useState<ContainersCollection>(new ContainersCollection);
  const [selectedContainers, setSelectedContainers] = useState<ContainersCollection>(new ContainersCollection);
  const [selectedDevices, setSelectedDevices] = useState<Device[]>(devices);
  const [statsStack, setStatsStack] = useState<StatsStack>(new StatsStack(MAX_STACK_ITEMS));
  const [charts, setCharts] = useState<Object[]>([]);
  const [maxChartsWarningShown, setMaxChartsWarningShown] = useState<boolean>(false);
  const [statsInterval, setStatsInterval] = useState<number>(1000);
  const [selectedAllContainers, setSelectedAllContainers] = useState<boolean>(false);
  const [selectedGraphMergeOption, setSelectedGraphMergeOption] = useState<string>(graphMergeOptions[0].value);
  const currentStatsRawRef = useRef<RawContainerStats[]>();
  const ddClient = useDockerDesktopClient();
  const theme = useTheme();

  useEffect(() => {
    identifyRunningContainers();
  }, []);

  const identifyRunningContainers = () => {
    ddClient.docker.cli.exec('ps', ['--format', '"{{json .}}"']).then((result) => {
      const runningContainers = new ContainersCollection;
      result.parseJsonLines().map((line) => {
        runningContainers.addContainer(new Container(line.ID, line.Names));
      });
      runningContainers.orderByName();
      setRunningContainers(runningContainers);
      setSelectedContainers(selectedContainers.removeContainersNotIn(runningContainers));
    });
  }

  useEffect(() => {
    if (selectedAllContainers || !runningContainers.hasContainers()) {
      return;
    }
    setSelectedAllContainers(true);
    if (runningContainers.hasContainers()) {
      const selectedContainers = new ContainersCollection
      runningContainers.getContainers().map((container: Container) => {
        selectedContainers.addContainer(container);
      });

      setSelectedContainers(selectedContainers);
    }
  }, [runningContainers])

  const makeStatsFromRaw = (rawStats: Array<RawContainerStats>): Stats => {
    const currentTime: string = new Date().toLocaleTimeString([], {
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    const stats: Stats = new Stats(currentTime);

    rawStats.map((rawContainerStats: RawContainerStats): void => {
      if (runningContainers) {
        stats.addContainerStats(new ContainerStats(currentTime, runningContainers.getContainerByName(rawContainerStats.Name), rawContainerStats))
      }
    });

    return stats;
  }

  useEffect(() => {
    const updateInterval = setInterval(() => {
      const rawStats = currentStatsRawRef.current;
      if (undefined !== rawStats) {
        if (containersChanged(runningContainers, rawStats)) {
          identifyRunningContainers();
          return;
        }
        const stats: Stats = makeStatsFromRaw(rawStats);
        setStatsStack((stack: StatsStack): StatsStack => stack.addUniqueStats(stats).clone());
      }
    }, statsInterval);

    return () => clearInterval(updateInterval);
  }, [statsInterval, runningContainers]);

  const containersChanged = (runningContainers: ContainersCollection, identifiedContainers: RawContainerStats[]): boolean => {
    const runningContainersNames: string[] = runningContainers.getContainers().map((container: Container) => container.getName());
    const identifiedContainersNames: string[] = identifiedContainers.map((container: RawContainerStats) => container.Name);

    return runningContainersNames.sort().toString() !== identifiedContainersNames.sort().toString();
  }

  useEffect((): void => {
    const chartsMaker: ChartsMaker = new ChartsMaker;
    let chartsCount: number = 0;

    if (!selectedContainers.hasContainers() || !selectedDevices) {
      setCharts([]);
      return;
    }
    let chartsLimitReached: boolean = false;

    if (selectedGraphMergeOption === 'split') {
      selectedDevices.forEach((selectedDevice: Device) => {
        selectedContainers.forEach((selectedContainer: Container) => {
          const chartItems: ChartItem[] = statsStack?.getStats().map((stats: Stats) => {
            return selectedDevice.makeSplitChartItem(stats.getContainerStats(selectedContainer));
          });

          const chartData: ChartData = new ChartData(chartItems);

          if (chartData.hasItems()) {
            if (chartsCount++ < MAX_CHARTS) {
              chartsMaker.addChart(selectedDevice, chartData);
            } else {
              chartsLimitReached = true;
            }
          }
        });
      });
    } else if (selectedGraphMergeOption === 'combine') {
      selectedDevices.forEach((selectedDevice: Device): void => {
        const chartItems: ChartItem[] = statsStack.getStats().map((stats: Stats): ChartItem => {
          return selectedDevice.makeCombinedChartItem(stats, selectedContainers);
        });

        const chartData: ChartData = new ChartData(chartItems);
        if (chartData.hasItems()) {
          if (chartsCount++ < MAX_CHARTS) {
            chartsMaker.addCombinedChart(selectedDevice, chartData);
          } else {
            chartsLimitReached = true;
          }
        }
      });
    } else if (selectedGraphMergeOption === 'overview') {
      selectedDevices.forEach((selectedDevice: Device): void => {
        const chartItems: ChartItem[] = statsStack.getStats().map((stats: Stats): ChartItem => {
          return selectedDevice.makeOverviewChartItem(stats, selectedContainers);
        });

        const chartData: ChartData = new ChartData(chartItems);
        if (chartData.hasItems()) {
          if (chartsCount++ < MAX_CHARTS) {
            chartsMaker.addChart(selectedDevice, chartData);
          } else {
            chartsLimitReached = true;
          }
        }
      });
    }

    if (chartsLimitReached && !maxChartsWarningShown) {
      ddClient.desktopUI.toast.success(`Too many charts to display. Showing only ${MAX_CHARTS} charts.`);
      setMaxChartsWarningShown(true);
    }

    setCharts(chartsMaker.getCharts());
  }, [selectedDevices, selectedContainers, selectedGraphMergeOption, statsStack]);

  useEffect(() => {
    let consecutiveFailedReads: number = 0;
    const statsStream = ddClient.docker.cli.exec('stats', ['--format', '{{json .}}'], {
      stream: {
        onOutput(data) {
          if (data.stdout) {
            const lines: string[] = data.stdout.toString().trim().split('\n');
            let rawParsedData = null;
            try {
              rawParsedData = lines.map((line: string) => JSON.parse(line));
              consecutiveFailedReads = 0;
            } catch (e: any) {
              consecutiveFailedReads++;
              rawParsedData = null;
            }

            if (consecutiveFailedReads > MAX_CONSECUTIVE_FAILED_READS) {
              identifyRunningContainers();
              consecutiveFailedReads = 0;
            }

            if (rawParsedData && rawParsedData.length > 0) {
              currentStatsRawRef.current = rawParsedData;
            }
          } else {
            console.error('Failed to parse', data.stdout);
          }
        },
        onError(error: any) {
          console.error(error);
        },
        splitOutputLines: false,
      }
    });

    return () => statsStream.close();
  }, []);

  const handleStatsOptionChange = (event: React.SyntheticEvent, checked: boolean): void => {
    const selectedValue: string = (event.target as HTMLInputElement).value;

    if (selectedDevices.some(s => s.getKey() === selectedValue)) {
      setSelectedDevices(prev => prev.filter((device: Device): boolean => device.getKey() !== selectedValue))
    } else {
      setSelectedDevices((prev: Device[]): Device[] => {
        const selectedDevice = devices.find((device: Device): boolean => device.getKey() === selectedValue);
        if (selectedDevice) {
          return [...prev, selectedDevice];
        }

        return prev;
      });
    }
  }

  const handleContainerSelectChange = (event: React.SyntheticEvent, checked: boolean): void => {
    const selectedContainerID = (event.target as HTMLInputElement).value;

    if (checked) {
      selectedContainers.addContainer(runningContainers.getContainerById(selectedContainerID));
    } else {
      selectedContainers.removeContainerByID(selectedContainerID);
    }

    setSelectedContainers(selectedContainers);
  }

  return (
    <Stack spacing={1}>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{
          backgroundColor: theme.palette.mode === 'dark' ? blueGrey[900] : blueGrey[50],
          border: '1px solid',
          borderRadius: 1,
          borderColor: theme.palette.mode === 'dark' ? blueGrey[800] : blueGrey[100],
          paddingX: 2,
          paddingY: 1,
        }}
      >
        <Stack alignItems="center">
          <Typography variant="h3">Live Charts</Typography>
          <Typography variant="body2">
            by <Link href="#" onClick={() => ddClient.host.openExternal('https://artifision.com')}>Artifision</Link>
          </Typography>
        </Stack>
        <Stack direction="row">
          <Divider orientation="vertical" variant="middle" flexItem/>
          <FormControl component="fieldset" sx={{marginX: 5}}>
            <FormGroup aria-label="position" row>
              {devices.map((device: Device) => (
                <FormControlLabel
                  key={device.getKey()}
                  value={device.getKey()}
                  control={<Switch color="primary"
                                   checked={selectedDevices.some(s => s.getKey() === device.getKey())}/>}
                  label={<Typography variant={'h3'} color={device.getColor()}>{device.getName()}</Typography>}
                  labelPlacement="top"
                  onChange={handleStatsOptionChange}
                />
              ))}
            </FormGroup>
          </FormControl>
          <Divider orientation="vertical" variant="middle" flexItem/>
        </Stack>
        <Stack>
          <Link href="#" onClick={() => ddClient.host.openExternal("https://forms.gle/LVQEgXfVuB3mgHDKA")}>
            Give Feedback <QuestionAnswerIcon />
          </Link>
        </Stack>
      </Stack>

      <Stack direction="row">
        <Stack
          spacing={4}
          sx={{
            flexShrink: 0,
            backgroundColor: theme.palette.mode === 'dark' ? blueGrey[900] : blueGrey[50],
            border: '1px solid',
            borderRadius: 1,
            borderColor: theme.palette.mode === 'dark' ? blueGrey[800] : blueGrey[100],
            padding: 2,
          }}>
          <FormControl>
            <Typography variant="h4">Graph Options:</Typography>
            <Divider/>
            <RadioGroup>
              {graphMergeOptions.map(option => (
                <FormControlLabel key={option.value} value={option.value} control={
                  <Radio checked={selectedGraphMergeOption === option.value}
                         size="medium"
                         onChange={() => setSelectedGraphMergeOption(option.value)}/>
                } label={option.name}/>
              ))}
            </RadioGroup>
          </FormControl>
          <FormControl>
            <Typography variant="h4">Containers:</Typography>
            <Divider/>
            <FormGroup>
              {runningContainers?.map((container: Container) =>
                <FormControlLabel
                  sx={{marginLeft: '-12px'}}
                  key={container.ID}
                  value={container.ID}
                  control={<Switch checked={selectedContainers.containsContainer(container)} size="small"/>}
                  label={<Typography sx={{
                    width: '150px',
                    textOverflow: 'ellipsis',
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                  }}>{container.getName()}</Typography>}
                  onChange={handleContainerSelectChange}
                />
              )}
              {!runningContainers.hasContainers() &&
                <FormLabel>No Containers Running.</FormLabel>
              }
            </FormGroup>
          </FormControl>
        </Stack>
        <Stack sx={{flexGrow: 1, width: '1px'}}>
          {runningContainers.hasContainers() && charts.map((chart: any) =>
            <Box key={chart.key} sx={{minHeight: '200px'}}>{chart.chart}</Box>
          )}
          {!runningContainers.hasContainers() &&
            <Typography variant="h4" sx={{alignSelf: 'center', m: 10}}>No Containers Running.</Typography>
          }
        </Stack>
      </Stack>
    </Stack>
  );
}
