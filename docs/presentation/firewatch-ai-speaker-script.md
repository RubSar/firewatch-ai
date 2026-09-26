# FireWatch AI — eight-minute pitch

Ten slides. Target pace: about 140 words per minute, with short pauses. Timing includes transitions. The deck presents a research-stage concept, not a deployed product.

## 1. FireWatch AI

0:00–0:35 (35 seconds)

Imagine a response team looking at a drone feed. They can see smoke and a patch of fire, but the operational question is harder: where is the active fire on the ground, and what has changed since the last pass? FireWatch AI is our proposal for answering that question. We combine drone imagery with position and orientation to build a timestamped view of observed fire. Our focus is specific: detect the fire that exists now and track the spread we can actually observe.

## 2. The gap between video and a usable update

0:35–1:20 (45 seconds)

A video feed gives an operator a view, but turning that view into a shared update takes interpretation. The camera moves. Smoke hides terrain. A hot patch may be active fire or residual heat. And an image that looked current a moment ago can become stale. Our starting user is the responder or analyst reviewing drone observations during an incident. We want to help that person distinguish a new observation from a real change on the ground. The opportunity is to make the evidence easier to inspect and compare, while keeping the human responsible for the operational decision.

## 3. The proposed product

1:20–2:10 (50 seconds)

FireWatch would turn usable drone observations into a map of currently observed fire, then compare that map with earlier observations. Selecting an area would reveal its supporting image, observation time and quality. Users could distinguish active fire from residual heat and see where the drone has not provided enough coverage. That distinction matters: an empty part of the map should never silently mean that an area is safe. The first version concentrates on this current-state picture and observed change. Future spread forecasts and pre-ignition risk are outside our initial scope. We believe this narrower product gives us a clearer problem to demonstrate and a clearer result to evaluate.

## 4. The evidence behind the map

2:10–3:00 (50 seconds)

The proposed inputs have different jobs. RGB imagery provides visible evidence such as fire and smoke. Infrared adds evidence of thermal anomalies. Drone position, orientation and camera pose help locate those observations on the ground, but GPS alone does not locate a hotspot. We also need camera calibration and suitable terrain or depth information. Weather and temperature provide context. They do not replace the visual evidence. We must also know what the sensors actually measure. A thermal color image does not automatically provide a reliable temperature in degrees. The hardware choices are still open, so our implementation must preserve those distinctions instead of pretending every feed is equally informative.

## 5. The processing workflow

3:00–3:55 (55 seconds)

The workflow begins by matching each frame to the telemetry from the moment it was captured. Computer vision then identifies fire evidence and tracks it across frames. Where the geometry is good enough, we project the detections onto the ground. Next, we compare observations of the same area at different times. This is the critical step: the system must account for camera motion and changing visibility before it calls something spread. Finally, the application publishes the current observation and its quality information. The browser consumes structured results through an API. An optional language model can turn those measurements into a readable briefing, but it does not determine the fire boundary or invent missing measurements. The core intelligence is visual and spatial.

## 6. An illustrative observation sequence

3:55–4:55 (60 seconds)

Here is the experience we want to demonstrate. On the first pass, the drone observes a section of active fire. FireWatch records that visible front with its timestamp and supporting frames. On a later pass, the drone returns to the same area. The camera may now be at a different angle, so we align the ground observations before comparing them. If the evidence supports movement, the analyst sees where the front changed and over which interval. If the drone simply reveals terrain that was hidden earlier, the application labels that as newly observed coverage. It does not call it new spread. The analyst can inspect both observations before sharing an update. This sequence is illustrative today. It describes the intended interaction and the behavior our prototype needs to prove.

## 7. Uncertainty is part of the result

4:55–5:40 (45 seconds)

A credible system needs a useful way to say that it does not know. If smoke obscures a region, we preserve that uncertainty. If geolocation is too weak, we can still show an image-space detection, but we should withhold ground distances and spread speed. If the feed stops, the map should make stale observations obvious. We also need to separate active fire from residual hot ground. These are product requirements, not just technical details, because they change how someone interprets the map. Our design goal is that every reported change comes with enough evidence and timing information for a person to question it.

## 8. What the first prototype must prove

5:40–6:35 (55 seconds)

The repository today contains research and a component scaffold, so we are not presenting field performance results. The next milestone is a repeatable prototype using a labeled, synchronized recording. We need to measure missed fire and false alarms, along with boundary and location error. We also need capture-to-display timing, including transmission and processing rather than inference alone. To validate observed movement, we should compare against annotated ground-referenced sequences. A particularly important test is a stationary fire viewed from a moving drone. The system should not report spread just because the camera moves. Another test reveals previously hidden terrain. Passing these tests would give us a defensible reason to move from a convincing presentation to a controlled field pilot.

## 9. A focused route to a field pilot

6:35–7:20 (45 seconds)

Our initial adoption hypothesis is to work with a drone operator and a responder or fire analyst on one constrained pilot. That gives us access to the real observation workflow and the person who needs the output. We would begin with recorded data, review errors together, and only then test a live feed under controlled conditions. The value question is concrete: can the analyst produce a clearer, more timely update with less manual comparison? We have not validated willingness to pay or chosen a pricing model. Those decisions should follow evidence that the workflow solves a problem for the intended user.

## 10. FireWatch AI

7:20–8:00 (40 seconds)

FireWatch AI has one initial job: help people see where active fire has been observed and how that observed front changes over time. The technical challenge is to connect visual detection with trustworthy ground location and careful temporal comparison. The product challenge is to make the result understandable, including its limits. Our next step is a focused prototype built around real synchronized observations and reviewed with a domain partner. We are looking for access to drone data and responder feedback so we can test that promise. Thank you.

